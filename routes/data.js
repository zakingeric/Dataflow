// routes/data.js — Buy data bundles
const express = require('express');
const { body, validationResult } = require('express-validator');

const db     = require('../config/database');
const logger = require('../config/logger');

// middleware
const { protect }   = require('../middleware/auth');
const serviceEnabled = require('../middleware/serviceEnabled');

// services
const walletService   = require('../services/walletService');
const vtuService      = require('../services/vtuService');
const emailService    = require('../services/emailService');
const paystackService = require('../services/paystackService');

const router = express.Router();

// ─────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────
router.use(protect);
router.use(serviceEnabled('data_service_active'));

// ─────────────────────────────────────────
// GET /api/data/plans
// ─────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const { network } = req.query;

    const query = network
      ? 'SELECT * FROM data_plans WHERE network = $1 AND is_active = true ORDER BY display_order, sell_price'
      : 'SELECT * FROM data_plans WHERE is_active = true ORDER BY network, display_order, sell_price';

    const params = network ? [network.toLowerCase()] : [];

    const { rows } = await db.query(query, params);

    res.json({
      success: true,
      plans: rows
    });
  } catch (err) {
    logger.error(err.message);
    res.status(500).json({
      success: false,
      message: 'Could not fetch plans'
    });
  }
});

// ─────────────────────────────────────────
// POST /api/data/buy
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
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { plan_id, phone, payment_method, paystack_reference } = req.body;

    // Get plan
    const { rows: [plan] } = await db.query(
      'SELECT * FROM data_plans WHERE id = $1 AND is_active = true',
      [plan_id]
    );

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Data plan not found'
      });
    }

    const amount    = parseFloat(plan.sell_price);
    const api_cost  = parseFloat(plan.buy_price);
    const profit    = amount - api_cost;

    const reference = `DF-DATA-${Date.now()}`;
    const detail    = `${plan.network.toUpperCase()} ${plan.name}`;

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const { rows: [txn] } = await client.query(
        `INSERT INTO transactions
        (reference, user_id, type, network, phone, plan_name, amount, api_cost, profit, payment_method, status)
        VALUES ($1,$2,'data',$3,$4,$5,$6,$7,$8,$9,'pending')
        RETURNING id`,
        [
          reference,
          req.user.id,
          plan.network,
          phone,
          plan.name,
          amount,
          api_cost,
          profit,
          payment_method
        ]
      );

      // PAYMENT METHOD
      if (payment_method === 'wallet') {
        await walletService.debitWallet(client, {
          user_id: req.user.id,
          amount,
          description: `Data purchase: ${detail}`,
          transaction_id: txn.id
        });
      } else {
        const psResult = await paystackService.verifyPayment(paystack_reference);

        if (!psResult.verified || psResult.amount < amount) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: 'Payment not verified'
          });
        }

        await client.query(
          `INSERT INTO paystack_payments
          (user_id, transaction_id, reference, amount, amount_kobo, purpose, status, channel)
          VALUES ($1,$2,$3,$4,$5,'direct_payment','success',$6)`,
          [
            req.user.id,
            txn.id,
            paystack_reference,
            amount,
            Math.round(amount * 100),
            psResult.channel
          ]
        );
      }

      await client.query('COMMIT');

      // CALL VTU
      const vtuResult = await vtuService.buyData({
        network: plan.network,
        phone,
        plan_code: plan.api_plan_code,
        reference
      });

      await db.query(
        `UPDATE transactions
        SET status='success', vtu_reference=$1, api_response=$2, updated_at=NOW()
        WHERE id=$3`,
        [vtuResult.vtu_reference, JSON.stringify(vtuResult.raw), txn.id]
      );

      emailService.sendTransactionSuccess({
        email: req.user.email,
        first_name: req.user.first_name,
        type: 'data',
        detail,
        amount,
        reference
      });

      res.json({
        success: true,
        message: 'Data purchase successful',
        reference
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    logger.error(err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

module.exports = router;
