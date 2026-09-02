const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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

const STAKE_OPTIONS = [5, 10, 20, 30, 40, 50, 80, 100];
const MAX_NUMBERS = 8;

const SPIN_PAYOUT_MULTIPLIER = 36;

const BET_LENGTH = 40;
const SPIN_LENGTH = 10;
const ROUND_LENGTH = BET_LENGTH + SPIN_LENGTH;

const WHEEL_ORDER = [
    0, 32, 15, 19, 4, 21, 2, 25, 17,
    34, 6, 27, 13, 36, 11, 30, 8, 23,
    10, 5, 24, 16, 33, 1, 20, 14, 31,
    9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];

const RED_NUMBERS = new Set([
    1, 3, 5, 7, 9, 12, 14, 16, 18,
    19, 21, 23, 25, 27, 30, 32, 34, 36
]);

function colorFor(n) {
    if (n === 0) return 'green';
    return RED_NUMBERS.has(n) ? 'red' : 'black';
}

const EVEN_MONEY_MULTIPLIER = 2;
const DOZEN_MULTIPLIER = 3;


/* =========================================================
   RISK MANAGEMENT
========================================================= */

const ALL_NUMBERS = Array.from(
    { length: 37 },
    (_, i) => i
);

const MAX_ROUND_LIABILITY =
    Number(
        process.env.MAX_ROUND_LIABILITY || 50000
    );

function payoutForOutcome(
    betType,
    numbers,
    stake,
    outcome
) {
    const color = colorFor(outcome);

    if (betType === 'number') {
        return numbers.indexOf(outcome) !== -1
            ? stake * SPIN_PAYOUT_MULTIPLIER
            : 0;
    }

    if (betType === 'red') {
        return color === 'red'
            ? stake * EVEN_MONEY_MULTIPLIER
            : 0;
    }

    if (betType === 'black') {
        return color === 'black'
            ? stake * EVEN_MONEY_MULTIPLIER
            : 0;
    }

    if (betType === 'odd') {
        return (
            outcome !== 0 &&
            outcome % 2 === 1
        )
            ? stake * EVEN_MONEY_MULTIPLIER
            : 0;
    }

    if (betType === 'even') {
        return (
            outcome !== 0 &&
            outcome % 2 === 0
        )
            ? stake * EVEN_MONEY_MULTIPLIER
            : 0;
    }

    if (betType === 'low') {
        return (
            outcome >= 1 &&
            outcome <= 18
        )
            ? stake * EVEN_MONEY_MULTIPLIER
            : 0;
    }

    if (betType === 'high') {
        return (
            outcome >= 19 &&
            outcome <= 36
        )
            ? stake * EVEN_MONEY_MULTIPLIER
            : 0;
    }

    if (betType === 'dozen1') {
        return (
            outcome >= 1 &&
            outcome <= 12
        )
            ? stake * DOZEN_MULTIPLIER
            : 0;
    }

    if (betType === 'dozen2') {
        return (
            outcome >= 13 &&
            outcome <= 24
        )
            ? stake * DOZEN_MULTIPLIER
            : 0;
    }

    if (betType === 'dozen3') {
        return (
            outcome >= 
