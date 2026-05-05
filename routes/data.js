// routes/data.js — Buy data bundles
const express = require('express');
const { body, validationResult } = require('express-validator');

const db            = require('../config/database');
const logger        = require('../config/logger');
const { protect, serviceEnabled } = require('../middleware/auth');
const walletService = require('../services/walletService');
const vtuService    = require('../services/vtuService');
const emailService  = require('../services/emailService');

const router = express.Router();
router.use(protect);
router.use(serviceEnabled('data_service_active'));

// ─────────────────────────────────────────
//  GET /api/data/plans?network=mtn
//  Get available plans for a network
// ─────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const { network } = req.query;
    const query = network
      ? 'SELECT * FROM data_plans WHERE network = $1 AND is_active = true ORDER BY display_order, sell_price'
      : 'SELECT * FROM data_plans WHERE is_active = true ORDER BY network, display_order, sell_price';
    const params = network ? [network.toLowerCase()] : [];
    const { rows } = await db.query(query, params);
    res.json({ success: true, plans: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not fetch plans' });
  }
});

// ─────────────────────────────────────────
//  POST /api/data/buy
// ─────────────────────────────────────────
router.post('/buy', [
  body('plan_id').isUUID().withMessage('Valid plan ID required'),
  body('phone')
    .matches(/^0[789][01]\d{8}$/)
    .withMessage('Valid Nigerian phone number required'),
  body('payment_method')
    .isIn(['wallet', 'card'])
    .withMessage('Payment method must be wallet or card'),
  body('paystack_reference')
    .if(body('payment_method').equals('card'))
    .notEmpty()
    .withMessage('Paystack reference required for card payment'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { plan_id, phone, payment_method, paystack_reference } = req.body;

    // Fetch plan
    const { rows: [plan] } = await db.query(
      'SELECT * FROM data_plans WHERE id = $1 AND is_active = true',
      [plan_id]
    );
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Data plan not found or unavailable' });
    }

    const amount    = parseFloat(plan.sell_price);
    const api_cost  = parseFloat(plan.buy_price);
    const profit    = amount - api_cost;
    const reference = `DF-DATA-${Date.now()}`;
    const detail    = `${plan.network.toUpperCase()} ${plan.name} (${plan.plan_type.toUpperCase()})`;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Create transaction record (pending)
      const { rows: [txn] } = await client.query(
        `INSERT INTO transactions
           (reference, user_id, type, network, phone, plan_name, amount, api_cost, profit, payment_method, status)
         VALUES ($1,$2,'data',$3,$4,$5,$6,$7,$8,$9,'pending')
         RETURNING id`,
        [reference, req.user.id, plan.network, phone, plan.name, amount, api_cost, profit, payment_method]
      );

      // ── PAYMENT ──
      if (payment_method === 'wallet') {
        // Debit wallet
        await walletService.debitWallet(client, {
          user_id:        req.user.id,
          amount,
          description:    `Data purchase: ${detail} → ${phone}`,
          transaction_id: txn.id,
        });
      } else {
        // Verify Paystack payment
        const psResult = await paystackService.verifyPayment(paystack_reference);
        if (!psResult.verified || psResult.amount < amount) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, message: 'Card payment not confirmed' });
        }
        // Record paystack payment
        await client.query(
          `INSERT INTO paystack_payments (user_id, transaction_id, reference, amount, amount_kobo, purpose, status, channel)
           VALUES ($1,$2,$3,$4,$5,'direct_payment','success',$6)`,
          [req.user.id, txn.id, paystack_reference, amount, Math.round(amount*100), psResult.channel]
        );
      }

      await client.query('COMMIT');

      // ── CALL VTU API (outside DB transaction) ──
      let vtuResult;
      try {
        vtuResult = await vtuService.buyData({
          network:    plan.network,
          phone,
          plan_code:  plan.api_plan_code,
          reference,
        });

        // Mark transaction success
        await db.query(
          `UPDATE transactions
           SET status='success', vtu_reference=$1, api_response=$2, updated_at=NOW()
           WHERE id=$3`,
          [vtuResult.vtu_reference, JSON.stringify(vtuResult.raw), txn.id]
        );

        // Send success email
        emailService.sendTransactionSuccess({
          email:      req.user.email,
          first_name: req.user.first_name,
          type:       'data',
          detail,
          amount,
          reference,
        });

        logger.info(`Data purchase success: ${reference} — ${detail} → ${phone}`);

        res.json({
          success:   true,
          message:   `${detail} data activated on ${phone}`,
          reference,
          plan:      { name: plan.name, network: plan.network, validity: `${plan.validity_days} days` },
        });

      } catch (vtuErr) {
        // VTU failed — refund wallet if wallet payment
        logger.error(`VTU failed for ${reference}: ${vtuErr.message}`);

        await db.query(
          `UPDATE transactions
           SET status='failed', failure_reason=$1, updated_at=NOW() WHERE id=$2`,
          [vtuErr.message, txn.id]
        );

        if (payment_method === 'wallet') {
          await walletService.refundTransaction({
            transaction_id: txn.id,
            user_id:        req.user.id,
            amount,
          });
        }

        emailService.sendTransactionFailed({
          email:      req.user.email,
          first_name: req.user.first_name,
          type:       'data',
          detail,
          amount,
          reference,
          reason:     vtuErr.message,
        });

        res.status(502).json({
          success:  false,
          message:  'Data delivery failed. Your payment has been refunded.',
          reference,
        });
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`Data buy error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
