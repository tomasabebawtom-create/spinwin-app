const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const STARTING_BALANCE = 0;
const STAKE_OPTIONS = [5, 10, 20, 30, 40, 50]; // must match frontend STAKE_OPTIONS
const MAX_NUMBERS = 8; // must match frontend MAX_NUMBERS
const SPIN_PAYOUT_MULTIPLIER = 36; // straight-up number bet: total return = perNumberStake * 36
const ROUND_LENGTH = 50; // must match frontend BET_LENGTH(40) + SPIN_LENGTH(10)

const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
function colorFor(n) { if (n === 0) return 'green'; return RED_NUMBERS.has(n) ? 'red' : 'black'; }
const EVEN_MONEY_MULTIPLIER = 2;
const DOZEN_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Risk management: cap how much the house can be liable for in a single
// round. This does NOT touch how the winning number is chosen (still fully
// random / fair) — it only refuses to accept a NEW bet if adding it would
// push the payout owed for any possible outcome (0-36) past a safety cap.
// ---------------------------------------------------------------------------
const ALL_NUMBERS = Array.from({ length: 37 }, (_, i) => i); // 0..36
const MAX_ROUND_LIABILITY = Number(process.env.MAX_ROUND_LIABILITY || 50000); // ብር — ማስተካከል ይቻላል

// ማንኛውም ውጤት (outcome, 0-36) ቢወጣ፣ ይህ ትኬት ምን ያህል እንደሚከፍል ይሰላል.
// `stake` here means: for 'number' bets, the PER-NUMBER stake; for every
// other bet type, the total ticket stake.
function payoutForOutcome(betType, numbers, stake, outcome) {
    const color = colorFor(outcome);
    if (betType === 'number') {
        return numbers.indexOf(outcome) !== -1 ? stake * SPIN_PAYOUT_MULTIPLIER : 0;
    }
    if (betType === 'red') return color === 'red' ? stake * EVEN_MONEY_MULTIPLIER : 0;
    if (betType === 'black') return color === 'black' ? stake * EVEN_MONEY_MULTIPLIER : 0;
    if (betType === 'odd') return (outcome !== 0 && outcome % 2 === 1) ? stake * EVEN_MONEY_MULTIPLIER : 0;
    if (betType === 'even') return (outcome !== 0 && outcome % 2 === 0) ? stake * EVEN_MONEY_MULTIPLIER : 0;
    if (betType === 'low') return (outcome >= 1 && outcome <= 18) ? stake * EVEN_MONEY_MULTIPLIER : 0;
    if (betType === 'high') return (outcome >= 19 && outcome <= 36) ? stake * EVEN_MONEY_MULTIPLIER : 0;
    if (betType === 'dozen1') return (outcome >= 1 && outcome <= 12) ? stake * DOZEN_MULTIPLIER : 0;
    if (betType === 'dozen2') return (outcome >= 13 && outcome <= 24) ? stake * DOZEN_MULTIPLIER : 0;
    if (betType === 'dozen3') return (outcome >= 25 && outcome <= 36) ? stake * DOZEN_MULTIPLIER : 0;
    return 0;
}

// { [round]: [37 numbers] } — running liability per possible outcome.
// NOTE: intentionally kept in-memory (not DB-backed). It's a soft safety
// valve, not money itself — if the server restarts mid-round the cap just
// resets to 0 for that round, which is a harmless (slightly more permissive)
// outcome, unlike losing ticket/balance data.
const roundLiability = {};

function getLiabilityArray(round) {
    if (!roundLiability[round]) roundLiability[round] = new Array(37).fill(0);
    return roundLiability[round];
}

function wouldExceedCap(round, betType, numbers, stake) {
    const liability = getLiabilityArray(round);
    for (let i = 0; i < ALL_NUMBERS.length; i++) {
        const outcome = ALL_NUMBERS[i];
        const added = payoutForOutcome(betType, numbers, stake, outcome);
        if (liability[outcome] + added > MAX_ROUND_LIABILITY) return true;
    }
    return false;
}

function addLiability(round, betType, numbers, stake) {
    const liability = getLiabilityArray(round);
    for (let i = 0; i < ALL_NUMBERS.length; i++) {
        const outcome = ALL_NUMBERS[i];
        liability[outcome] += payoutForOutcome(betType, numbers, stake, outcome);
    }
}

// Old rounds' liability arrays are no longer needed once resolved — clean up
// a few cycles back so this object doesn't grow forever.
function cleanupOldLiability(currentRound) {
    const cutoff = currentRound - 5;
    Object.keys(roundLiability).forEach(function (key) {
        if (Number(key) < cutoff) delete roundLiability[key];
    });
}
// ---------------------------------------------------------------------------

if (!DATABASE_URL) { console.warn('DATABASE_URL not set'); }
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const memBalances = {};
const memOrders = { nextId: 1, orders: {} };

// In-memory fallback stores, used only when there's no DATABASE_URL
// (e.g. local dev). When pool exists, round_tickets / resolved_rounds
// tables are the source of truth instead.
const memRoundTickets = {};
const memResolvedRounds = {};

async function initDb() {
    if (!pool) return;
    await pool.query('CREATE TABLE IF NOT EXISTS balances (user_id TEXT PRIMARY KEY, balance NUMERIC NOT NULL DEFAULT 0)');
    await pool.query('CREATE TABLE IF NOT EXISTS orders (order_id SERIAL PRIMARY KEY, type TEXT NOT NULL, user_id TEXT NOT NULL, amount NUMERIC NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', phone TEXT, confirmed_by TEXT, rejected_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await pool.query('CREATE TABLE IF NOT EXISTS round_tickets (round BIGINT NOT NULL, user_id TEXT NOT NULL, ticket_id TEXT NOT NULL, bet_type TEXT NOT NULL, numbers JSONB NOT NULL DEFAULT \'[]\', stake NUMERIC NOT NULL, per_number_stake NUMERIC NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (round, user_id))');
    await pool.query('CREATE TABLE IF NOT EXISTS resolved_rounds (round BIGINT PRIMARY KEY, winning_number INT NOT NULL, winning_color TEXT NOT NULL, resolved_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    console.log('Database tables ready');
}

async function getBalance(userId) {
    if (!pool) { if (!(userId in memBalances)) memBalances[userId] = STARTING_BALANCE; return memBalances[userId]; }
    const result = await pool.query('SELECT balance FROM balances WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) {
        await pool.query('INSERT INTO balances (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, STARTING_BALANCE]);
        return STARTING_BALANCE;
    }
    return Number(result.rows[0].balance);
}

async function changeBalance(userId, delta) {
    if (!pool) { const current = await getBalance(userId); memBalances[userId] = current + delta; return memBalances[userId]; }
    await getBalance(userId);
    const result = await pool.query('UPDATE balances SET balance = balance + $2 WHERE user_id = $1 RETURNING balance', [userId, delta]);
    return Number(result.rows[0].balance);
}

async function createOrder(type, userId, amount, extra) {
    extra = extra || {};
    if (!pool) {
        const orderId = String(memOrders.nextId++);
        memOrders.orders[orderId] = { type: type, userId: userId, amount: amount, status: 'pending', createdAt: new Date().toISOString(), phone: extra.phone };
        return orderId;
    }
    const result = await pool.query('INSERT INTO orders (type, user_id, amount, phone) VALUES ($1, $2, $3, $4) RETURNING order_id', [type, userId, amount, extra.phone || null]);
    return String(result.rows[0].order_id);
}

async function getOrder(orderId) {
    if (!pool) return memOrders.orders[orderId];
    const result = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { type: row.type, userId: row.user_id, amount: Number(row.amount), status: row.status, phone: row.phone };
}

async function markOrder(orderId, status, adminId) {
    if (!pool) {
        const order = memOrders.orders[orderId];
        if (!order) return;
        order.status = status;
        return;
    }
    const col = status === 'confirmed' ? 'confirmed_by' : 'rejected_by';
    const sql = 'UPDATE orders SET status = $2, ' + col + ' = $3 WHERE order_id = $1';
    await pool.query(sql, [orderId, status, adminId]);
}

// ---------------------------------------------------------------------------
// Round tickets / resolved rounds — DB-backed (with in-memory fallback when
// there's no DATABASE_URL) so bets and results survive a server restart.
// ---------------------------------------------------------------------------

async function saveTicket(round, userId, ticket) {
    if (!pool) {
        if (!memRoundTickets[round]) memRoundTickets[round] = {};
        memRoundTickets[round][userId] = ticket;
        return;
    }
    await pool.query(
        'INSERT INTO round_tickets (round, user_id, ticket_id, bet_type, numbers, stake, per_number_stake) VALUES ($1, $2, $3, $4, $5, $6, $7) ' +
        'ON CONFLICT (round, user_id) DO NOTHING',
        [round, userId, ticket.ticketId, ticket.betType, JSON.stringify(ticket.numbers), ticket.stake, ticket.perNumberStake]
    );
}

async function getTicket(round, userId) {
    if (!pool) {
        return memRoundTickets[round] && memRoundTickets[round][userId];
    }
    const result = await pool.query('SELECT * FROM round_tickets WHERE round = $1 AND user_id = $2', [round, userId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
        ticketId: row.ticket_id,
        betType: row.bet_type,
        numbers: row.numbers || [],
        stake: Number(row.stake),
        perNumberStake: Number(row.per_number_stake)
    };
}

// Resolves a round's winning number, atomically-ish: if two requests race to
// resolve the same round, INSERT ... ON CONFLICT makes sure only one number
// ever "wins" for that round — everyone reads back the same stored result.
async function resolveRound(round) {
    if (!pool) {
        if (!memResolvedRounds[round]) {
            const winningNumber = WHEEL_ORDER[Math.floor(Math.random() * WHEEL_ORDER.length)];
            memResolvedRounds[round] = { winning_number: winningNumber, winning_color: colorFor(winningNumber) };
            cleanupOldLiability(round);
            console.log('[SPIN]', 'round=' + round, 'winningNumber=' + winningNumber);
        }
        return memResolvedRounds[round];
    }
    const existing = await pool.query('SELECT winning_number, winning_color FROM resolved_rounds WHERE round = $1', [round]);
    if (existing.rows.length > 0) {
        return { winning_number: existing.rows[0].winning_number, winning_color: existing.rows[0].winning_color };
    }
    const winningNumber = WHEEL_ORDER[Math.floor(Math.random() * WHEEL_ORDER.length)];
    const winningColor = colorFor(winningNumber);
    const inserted = await pool.query(
        'INSERT INTO resolved_rounds (round, winning_number, winning_color) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (round) DO UPDATE SET round = resolved_rounds.round RETURNING winning_number, winning_color',
        [round, winningNumber, winningColor]
    );
    cleanupOldLiability(round);
    console.log('[SPIN]', 'round=' + round, 'winningNumber=' + inserted.rows[0].winning_number);
    return { winning_number: inserted.rows[0].winning_number, winning_color: inserted.rows[0].winning_color };
}
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------

// ሁሉንም {userId, balance} ተጠቃሚዎች ይመልሳል
async function getAllBalances() {
    if (!pool) {
        return Object.keys(memBalances).map(function (userId) {
            return { userId: userId, balance: memBalances[userId] };
        });
    }
    const result = await pool.query('SELECT user_id, balance FROM balances ORDER BY user_id');
    return result.rows.map(function (row) {
        return { userId: row.user_id, balance: Number(row.balance) };
    });
}

// የተረጋገጡ (confirmed) deposit/withdraw ትዕዛዞችን ድምር ይመልሳል
async function getConfirmedTotals() {
    if (!pool) {
        let totalDeposits = 0;
        let totalWithdrawals = 0;
        Object.keys(memOrders.orders).forEach(function (orderId) {
            const order = memOrders.orders[orderId];
            if (order.status !== 'confirmed') return;
            if (order.type === 'deposit') totalDeposits += Number(order.amount);
            if (order.type === 'withdraw') totalWithdrawals += Number(order.amount);
        });
        return { totalDeposits: totalDeposits, totalWithdrawals: totalWithdrawals };
    }
    const depResult = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE type = 'deposit' AND status = 'confirmed'");
    const wdResult = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE type = 'withdraw' AND status = 'confirmed'");
    return { totalDeposits: Number(depResult.rows[0].total), totalWithdrawals: Number(wdResult.rows[0].total) };
}

// አድሚን routes ን የሚጠብቅ middleware — 'x-admin-secret' header ወይም
// '?secret=' query parameter በ ADMIN_SECRET እኩል መሆን አለበት።
function requireAdmin(req, res, next) {
    if (!ADMIN_SECRET) {
        return res.status(503).json({ error: 'admin access not configured' });
    }
    const provided = req.get('x-admin-secret') || req.query.secret || '';
    if (provided !== ADMIN_SECRET) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

app.get('/api/admin/stats', requireAdmin, async function (req, res) {
    try {
        const balances = await getAllBalances();
        const totals = await getConfirmedTotals();
        const netProfit = totals.totalDeposits - totals.totalWithdrawals - balances.reduce(function (sum, u) { return sum + u.balance; }, 0);
        res.json({
            total_users: balances.length,
            total_deposits: totals.totalDeposits,
            total_withdrawals: totals.totalWithdrawals,
            net_profit: netProfit,
            online_now: countOnline()
        });
    } catch (err) {
        console.error('admin/stats error:', err);
        res.status(500).json({ error: 'failed to load stats' });
    }
});

app.get('/api/admin/users-report', requireAdmin, async function (req, res) {
    try {
        const balances = await getAllBalances();
        const cutoff = Date.now() - ONLINE_WINDOW_MS;
        const withOnline = balances.map(function (u) {
            const seen = lastSeen[u.userId];
            return {
                userId: u.userId,
                name: seen ? seen.name : null,
                balance: u.balance,
                online: !!(seen && seen.ts >= cutoff)
            };
        });
        res.json({ users: withOnline });
    } catch (err) {
        console.error('admin/users-report error:', err);
        res.status(500).json({ error: 'failed to load users report' });
    }
});

// የቅርብ ጊዜ እንቅስቃሴ (ውርርድ/ውጤት) ዝርዝር — ማን ተጫውቷል፣ ማን አሸነፈ፣ ስንት ብር
app.get('/api/admin/activity', requireAdmin, async function (req, res) {
    const limit = Math.min(Number(req.query.limit) || 50, ACTIVITY_LOG_MAX);
    res.json({ activity: activityLog.slice(0, limit) });
});
// ---------------------------------------------------------------------------

function sortEntries(entries) {
    entries.sort(function (a, b) {
        if (a[0] < b[0]) return -1;
        if (a[0] > b[0]) return 1;
        return 0;
    });
    return entries;
}

function validateInitData(initData) {
    if (!BOT_TOKEN) { return parseUnsafe(initData); }
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const entries = sortEntries(Array.from(params.entries()));
        const parts = [];
        for (let i = 0; i < entries.length; i++) {
            parts.push(entries[i][0] + '=' + entries[i][1]);
        }
        const dataCheckString = parts.join(String.fromCharCode(10));
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return null;
        const userJson = params.get('user');
        if (!userJson) return null;
        const user = JSON.parse(userJson);
        return { id: String(user.id), first_name: user.first_name };
    } catch (e) {
        return null;
    }
}

function parseUnsafe(initData) {
    try {
        const params = new URLSearchParams(initData);
        const userJson = params.get('user');
        if (!userJson) return null;
        const user = JSON.parse(userJson);
        return { id: String(user.id), first_name: user.first_name };
    } catch (e) {
        return null;
    }
}

function currentRoundId() { return Math.floor(Date.now() / 1000 / ROUND_LENGTH); }

// ---------------------------------------------------------------------------
// Live monitoring: who's online right now, and a rolling feed of recent bets
// / wins so the admin can watch activity without querying the DB.
// ---------------------------------------------------------------------------
const ONLINE_WINDOW_MS = 30 * 1000; // ተጠቃሚው ባለፉት 30 ሰከንድ ውስጥ ጥያቄ ካደረገ "online" ተብሎ ይቆጠራል
const lastSeen = {}; // userId -> timestamp (ms)
const ACTIVITY_LOG_MAX = 200;
const activityLog = []; // newest first

function touch(userId, name) {
    lastSeen[userId] = { ts: Date.now(), name: name || null };
}

function countOnline() {
    const cutoff = Date.now() - ONLINE_WINDOW_MS;
    let count = 0;
    Object.keys(lastSeen).forEach(function (userId) {
        if (lastSeen[userId].ts >= cutoff) count++;
    });
    return count;
}

function logActivity(entry) {
    entry.time = new Date().toISOString();
    activityLog.unshift(entry);
    if (activityLog.length > ACTIVITY_LOG_MAX) activityLog.length = ACTIVITY_LOG_MAX;
}
// ---------------------------------------------------------------------------

app.get('/', function (req, res) {
    res.send('Spin and Win API server is running');
});

app.get('/api/balance', async function (req, res) {
    const initData = req.query.initData || '';
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });
    touch(user.id, user.first_name);
    res.json({ balance: await getBalance(user.id) });
});

app.get('/api/balance/:userId', async function (req, res) {
    res.json({ balance: await getBalance(String(req.params.userId)) });
});

app.post('/api/place-ticket', async function (req, res) {
    const initData = req.body.initData;
    const round = req.body.round;
    const betType = req.body.betType;
    const numbers = req.body.numbers;
    const requestedStake = req.body.stake;
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });
    if (round !== currentRoundId()) return res.status(400).json({ error: 'round closed' });
    const VALID_TYPES = ['number', 'red', 'black', 'odd', 'even', 'dozen1', 'dozen2', 'dozen3', 'low', 'high'];
    if (VALID_TYPES.indexOf(betType) === -1) return res.status(400).json({ error: 'invalid bet type' });
    if (STAKE_OPTIONS.indexOf(requestedStake) === -1) return res.status(400).json({ error: 'invalid stake' });

    // Only one ticket per user per round.
    const existingTicket = await getTicket(round, user.id);
    if (existingTicket) return res.status(409).json({ error: 'already placed a ticket this round' });

    // perNumberStake is what each single number costs / what a single number pays out against.
    // For outside bets, the whole ticket is one unit at requestedStake.
    const perNumberStake = requestedStake;
    let stake = requestedStake;

    if (betType === 'number') {
        if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'select a number' });
        if (numbers.length > MAX_NUMBERS) return res.status(400).json({ error: 'too many numbers' });
        for (let i = 0; i < numbers.length; i++) {
            const n = numbers[i];
            if (typeof n !== 'number' || n < 0 || n > 36) return res.status(400).json({ error: 'invalid number' });
        }
        stake = numbers.length * requestedStake; // total cost = one requestedStake per marked number
    }

    const balance = await getBalance(user.id);
    if (balance < stake) return res.status(400).json({ error: 'insufficient balance' });

    // Risk cap: refuse the bet if it would push any possible outcome's
    // payout liability for this round past the safety threshold.
    const payoutStake = betType === 'number' ? perNumberStake : stake;
    if (wouldExceedCap(round, betType, numbers || [], payoutStake)) {
        return res.status(400).json({ error: 'ይህ ውርርድ በአሁኑ ጊዜ ተቀባይነት የለውም (ከፍተኛ ገደብ ደርሷል)' });
    }
    addLiability(round, betType, numbers || [], payoutStake);

    await changeBalance(user.id, -stake);
    const ticketId = round + '-' + user.id;
    const ticket = { betType: betType, numbers: numbers || [], stake: stake, perNumberStake: perNumberStake, ticketId: ticketId };
    await saveTicket(round, user.id, ticket);
    touch(user.id, user.first_name);
    logActivity({ type: 'bet', userId: user.id, name: user.first_name || null, betType: betType, numbers: numbers || [], stake: stake, round: round });
    console.log('[BET]', 'user=' + user.id, 'round=' + round, 'betType=' + betType, 'numbers=' + JSON.stringify(numbers), 'stake=' + stake);
    res.json({ ticket_id: ticketId, balance: await getBalance(user.id) });
});

app.get('/api/round-result', async function (req, res) {
    const initData = req.query.initData || '';
    const round = parseInt(req.query.round, 10);
    const ticketId = req.query.ticket_id;
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });

    const resolved = await resolveRound(round);
    const winning_number = resolved.winning_number;
    const winning_color = resolved.winning_color;
    let won = false;
    let amount = 0;
    const ticket = await getTicket(round, user.id);
    if (ticket && ticket.ticketId === ticketId) {
        if (ticket.betType === 'number') {
            // pays perNumberStake * 36 (the amount actually risked on THAT single number), not the ticket total
            if (ticket.numbers.indexOf(winning_number) !== -1) { won = true; amount = ticket.perNumberStake * SPIN_PAYOUT_MULTIPLIER; }
        } else if (ticket.betType === 'red' || ticket.betType === 'black') {
            won = winning_color === ticket.betType;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'odd') {
            won = winning_number !== 0 && winning_number % 2 === 1;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'even') {
            won = winning_number !== 0 && winning_number % 2 === 0;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'low') {
            won = winning_number >= 1 && winning_number <= 18;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'high') {
            won = winning_number >= 19 && winning_number <= 36;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'dozen1') {
            won = winning_number >= 1 && winning_number <= 12;
            amount = won ? ticket.stake * DOZEN_MULTIPLIER : 0;
        } else if (ticket.betType === 'dozen2') {
            won = winning_number >= 13 && winning_number <= 24;
            amount = won ? ticket.stake * DOZEN_MULTIPLIER : 0;
        } else if (ticket.betType === 'dozen3') {
            won = winning_number >= 25 && winning_number <= 36;
            amount = won ? ticket.stake * DOZEN_MULTIPLIER : 0;
        }
        if (won && amount > 0) { await changeBalance(user.id, amount); }
        touch(user.id, user.first_name);
        logActivity({ type: 'result', userId: user.id, name: user.first_name || null, betType: ticket.betType, stake: ticket.stake, won: won, amount: amount, winningNumber: winning_number, round: round });
        console.log('[RESULT]', 'user=' + user.id, 'round=' + round, 'yourNumbers=' + JSON.stringify(ticket.numbers), 'winningNumber=' + winning_number, 'won=' + won);
    }
    res.json({ winning_number: winning_number, winning_color: winning_color, won: won, amount: amount, balance: await getBalance(user.id) });
});

app.post('/api/deposit/request', async function (req, res) {
    const userId = req.body.userId;
    const amount = req.body.amount;
    if (!userId || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Invalid request' });
    const orderId = await createOrder('deposit', String(userId), amount);
    res.json({ orderId: orderId });
});

app.post('/api/deposit/confirm', requireAdmin, async function (req, res) {
    const orderId = req.body.orderId;
    const adminId = req.body.adminId;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });
    await markOrder(orderId, 'confirmed', adminId);
    const newBalance = await changeBalance(order.userId, order.amount);
    res.json({ userId: order.userId, balance: newBalance });
});

app.post('/api/deposit/reject', requireAdmin, async function (req, res) {
    const orderId = req.body.orderId;
    const adminId = req.body.adminId;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });
    await markOrder(orderId, 'rejected', adminId);
    res.json({ userId: orderId });
});

app.post('/api/withdraw/request', async function (req, res) {
    const userId = req.body.userId;
    const amount = req.body.amount;
    const phone = req.body.phone;
    if (!userId || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Invalid request' });
    if (!phone || typeof phone !== 'string' || !phone.trim()) return res.status(400).json({ error: 'Phone number required' });
    const currentBalance = await getBalance(String(userId));
    if (currentBalance < amount) return res.status(400).json({ error: 'insufficient balance' });
    await changeBalance(String(userId), -amount);
    const orderId = await createOrder('withdraw', String(userId), amount, { phone: phone.trim() });
    res.json({ orderId: orderId, balance: await getBalance(String(userId)) });
});

app.post('/api/withdraw/confirm', requireAdmin, async function (req, res) {
    const orderId = req.body.orderId;
    const adminId = req.body.adminId;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });
    await markOrder(orderId, 'confirmed', adminId);
    res.json({ userId: order.userId, balance: await getBalance(String(order.userId)) });
});

app.post('/api/withdraw/reject', requireAdmin, async function (req, res) {
    const orderId = req.body.orderId;
    const adminId = req.body.adminId;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });
    await changeBalance(String(order.userId), order.amount);
    await markOrder(orderId, 'rejected', adminId);
    res.json({ userId: order.userId, balance: await getBalance(String(order.userId)) });
});

initDb().then(function () {
    app.listen(PORT, function () {
        console.log('Server listening on port ' + PORT);
    });
}).catch(function (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
