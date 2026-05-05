// routes/wallet.js
const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const db              = require('../config/database');
const logger          = require('../config/logger');
const { protect }     = require('../middleware/auth');
const walletService   = require('../services/walletService');
const paystackService = require('../services/paystackService');
const emailService    = require('../services/emailService');

const router = express.Router();
router.use(protect); // all wallet routes require login

// ─────────────────────────────────────────
//  GET /api/wallet — get my wallet balance
// ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows: [wallet] } = await db.query(
      `SELECT w.*, 
              (SELECT COUNT(*) FROM transactions WHERE user_id = $1) AS total_transactions
       FROM wallets w WHERE w.user_id = $1`,
      [req.user.id]
    );
    res.json({ success: true, wallet });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not fetch wallet' });
  }
});

// ─────────────────────────────────────────
//  POST /api/wallet/fund/initialize
//  Step 1: Initialize Paystack payment
// ─────────────────────────────────────────
router.post('/fund/initialize', [
  body('amount')
    .isFloat({ min: 100 })
    .withMessage('Minimum funding amount is ₦100'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { amount } = req.body;
    const max = parseFloat(process.env.MAX_WALLET_FUNDING || 500000);

    if (parseFloat(amount) > max) {
      return res.status(400).json({
        success: false,
        message: `Maximum single funding is ₦${max.toLocaleString()}`,
      });
    }

    // Generate unique reference
    const reference = `DF-FUND-${Date.now()}-${req.user.id.slice(0, 8)}`;

    // Record pending payment in DB
    await db.query(
      `INSERT INTO paystack_payments (user_id, reference, amount, amount_kobo, purpose, status)
       VALUES ($1, $2, $3, $4, 'wallet_fund', 'pending')`,
      [req.user.id, reference, amount, Math.round(amount * 100)]
    );

    // Initialize with Paystack
    const payment = await paystackService.initializePayment({
      email:     req.user.email,
      amount:    parseFloat(amount),
      reference,
      metadata:  { user_id: req.user.id, purpose: 'wallet_fund' },
    });

    res.json({
      success:           true,
      authorization_url: payment.data.authorization_url,
      reference:         payment.data.reference,
      amount,
    });
  } catch (err) {
    logger.error(`Wallet fund init error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  POST /api/wallet/fund/verify
//  Step 2: Verify after Paystack redirect
//  (backup — primary verification is via webhook)
// ─────────────────────────────────────────
router.post('/fund/verify', [
  body('reference').notEmpty(),
], async (req, res) => {
  try {
    const { reference } = req.body;

    // Check this payment belongs to this user and is still pending
    const { rows: [payment] } = await db.query(
      `SELECT * FROM paystack_payments WHERE reference = $1 AND user_id = $2`,
      [reference, req.user.id]
    );

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (payment.status === 'success') {
      return res.json({ success: true, message: 'Wallet already credited', already_done: true });
    }

    // Verify with Paystack
    const result = await paystackService.verifyPayment(reference);

    if (!result.verified) {
      return res.status(400).json({ success: false, message: 'Payment not confirmed by Paystack' });
    }

    // Credit wallet (idempotent check already done above)
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Mark payment as success
      await client.query(
        `UPDATE paystack_payments SET status='success', channel=$1, paystack_data=$2, verified_at=NOW()
         WHERE reference=$3`,
        [result.channel, JSON.stringify(result.data), reference]
      );

      // Credit wallet
      const walletResult = await walletService.creditWallet(client, {
        user_id:     req.user.id,
        amount:      result.amount,
        description: `Wallet funded via Paystack (${reference})`,
      });

      // Check if first-time funding — give bonus
      const { rows: [wallet] } = await client.query(
        'SELECT total_funded FROM wallets WHERE user_id = $1',
        [req.user.id]
      );
      const isFirstFund = parseFloat(wallet.total_funded) === 0;
      const bonusAmount = parseFloat(process.env.BONUS_ON_FIRST_FUND || 0);

      if (isFirstFund && bonusAmount > 0) {
        await walletService.creditBonus(client, {
          user_id:     req.user.id,
          amount:      bonusAmount,
          description: 'First wallet funding bonus',
        });
      }

      await client.query('COMMIT');

      // Send email (non-blocking)
      emailService.sendWalletFunded({
        email:      req.user.email,
        first_name: req.user.first_name,
        amount:     result.amount,
        balance:    walletResult.balance_after,
        reference,
      });

      logger.info(`Wallet funded (verify route): user=${req.user.id} amount=₦${result.amount}`);

      res.json({
        success: true,
        message: `Wallet credited with ₦${result.amount.toLocaleString()}`,
        balance: walletResult.balance_after,
        bonus:   isFirstFund && bonusAmount > 0 ? bonusAmount : 0,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`Wallet verify error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  GET /api/wallet/ledger — wallet transaction history
// ─────────────────────────────────────────
router.get('/ledger', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { rows } = await db.query(
      `SELECT wl.*, t.type AS tx_type, t.reference AS tx_ref
       FROM wallet_ledger wl
       LEFT JOIN transactions t ON t.id = wl.transaction_id
       WHERE wl.user_id = $1
       ORDER BY wl.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    res.json({ success: true, ledger: rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not fetch ledger' });
  }
});

module.exports = router;
