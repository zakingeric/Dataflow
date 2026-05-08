// routes/data.js — Buy data bundles
const express = require('express');
const { body, validationResult } = require('express-validator');

const db = require('../config/database');
const logger = require('../config/logger');

// IMPORTANT: middleware imports must exist correctly
const { protect, serviceEnabled } = require('../middleware/serviceEnabled');

const walletService = require('../services/walletService');
const vtuService = require('../services/vtuService');
const emailService = require('../services/emailService');

const router = express.Router();

// Protect all routes first
router.use(protect);

// Feature toggle middleware
router.use(serviceEnabled('data_service_active'));

// ─────────────────────────────────────────
// GET /api/data/plans
// ─────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const { network } = req.query;

    const query = network
      ? 'SELECT * FROM data_plans WHERE network = $1 AND is_active = true ORDER BY sell_price'
      : 'SELECT * FROM data_plans WHERE is_active = true ORDER BY network, sell_price';

    const params = network ? [network.toLowerCase()] : [];

    const { rows } = await db.query(query, params);

    res.json({ success: true, plans: rows });
  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ success: false, message: 'Could not fetch plans' });
  }
});

// ─────────────────────────────────────────
// POST /api/data/buy
// ─────────────────────────────────────────
router.post(
  '/buy',
  [
    body('plan_id').notEmpty(),
    body('phone').matches(/^0[789][01]\d{8}$/),
    body('payment_method').isIn(['wallet', 'card']),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { plan_id, phone, payment_method } = req.body;

      const { rows: [plan] } = await db.query(
        'SELECT * FROM data_plans WHERE id = $1 AND is_active = true',
        [plan_id]
      );

      if (!plan) {
        return res.status(404).json({ success: false, message: 'Plan not found' });
      }

      const amount = Number(plan.sell_price);
      const reference = `DF-${Date.now()}`;

      const client = await db.connect();

      try {
        await client.query('BEGIN');

        const { rows: [txn] } = await client.query(
          `INSERT INTO transactions
           (reference, user_id, type, network, phone, plan_name, amount, status)
           VALUES ($1,$2,'data',$3,$4,$5,$6,'pending')
           RETURNING id`,
          [reference, req.user.id, plan.network, phone, plan.name, amount]
        );

        if (payment_method === 'wallet') {
          await walletService.debitWallet(client, {
            user_id: req.user.id,
            amount,
            description: `Data purchase ${plan.name}`,
            transaction_id: txn.id,
          });
        }

        await client.query('COMMIT');

        const vtuResult = await vtuService.buyData({
          network: plan.network,
          phone,
          plan_code: plan.api_plan_code,
          reference,
        });

        await db.query(
          `UPDATE transactions SET status='success' WHERE id=$1`,
          [txn.id]
        );

        res.json({
          success: true,
          message: 'Data purchase successful',
          reference,
        });

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

    } catch (err) {
      logger.error(err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
