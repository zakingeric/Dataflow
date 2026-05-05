// routes/admin.js — Admin-only endpoints
const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db      = require('../config/database');
const logger  = require('../config/logger');
const { protect, adminOnly } = require('../middleware/auth');
const walletService = require('../services/walletService');
const vtuService    = require('../services/vtuService');

const router = express.Router();
router.use(protect, adminOnly); // All admin routes require admin role

// ─────────────────────────────────────────
//  GET /api/admin/dashboard — stats overview
// ─────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const [revenue, orders, users, wallets, pending, failed, recentOrders] = await Promise.all([
      // Today's revenue
      db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE status='success' AND created_at >= CURRENT_DATE`),
      // Today's orders
      db.query(`SELECT COUNT(*) FROM transactions WHERE created_at >= CURRENT_DATE`),
      // Total users
      db.query(`SELECT COUNT(*) FROM users WHERE role='customer'`),
      // Total wallet balance held
      db.query(`SELECT COALESCE(SUM(balance),0) AS total FROM wallets`),
      // Pending orders
      db.query(`SELECT COUNT(*) FROM transactions WHERE status='pending'`),
      // Failed today
      db.query(`SELECT COUNT(*) FROM transactions WHERE status='failed' AND created_at >= CURRENT_DATE`),
      // Recent 10 orders
      db.query(`SELECT t.*, u.first_name, u.last_name, u.email
                FROM transactions t JOIN users u ON u.id=t.user_id
                ORDER BY t.created_at DESC LIMIT 10`),
    ]);

    // Revenue by service type
    const { rows: byType } = await db.query(
      `SELECT type, COUNT(*) AS orders, COALESCE(SUM(amount),0) AS revenue, COALESCE(SUM(profit),0) AS profit
       FROM transactions WHERE status='success' AND created_at >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY type ORDER BY revenue DESC`
    );

    // Last 7 days revenue
    const { rows: daily } = await db.query(
      `SELECT DATE(created_at) AS date, COALESCE(SUM(amount),0) AS revenue,
              COUNT(*) AS orders, COALESCE(SUM(profit),0) AS profit
       FROM transactions WHERE status='success' AND created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY DATE(created_at) ORDER BY date`
    );

    res.json({
      success: true,
      stats: {
        today_revenue:  parseFloat(revenue.rows[0].total),
        today_orders:   parseInt(orders.rows[0].count),
        total_users:    parseInt(users.rows[0].count),
        wallet_balance: parseFloat(wallets.rows[0].total),
        pending_orders: parseInt(pending.rows[0].count),
        failed_today:   parseInt(failed.rows[0].count),
      },
      by_type:      byType,
      daily:        daily,
      recent_orders: recentOrders.rows,
    });
  } catch (err) {
    logger.error(`Admin dashboard error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  GET /api/admin/orders
// ─────────────────────────────────────────
router.get('/orders', async (req, res) => {
  try {
    const { page=1, limit=50, status, type, search } = req.query;
    const offset = (page-1)*limit;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`t.status=$${idx++}`); params.push(status); }
    if (type)   { conditions.push(`t.type=$${idx++}`);   params.push(type); }
    if (search) {
      conditions.push(`(u.email ILIKE $${idx} OR t.phone ILIKE $${idx} OR t.reference ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(
      `SELECT t.*, u.first_name, u.last_name, u.email
       FROM transactions t JOIN users u ON u.id=t.user_id
       ${where} ORDER BY t.created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM transactions t JOIN users u ON u.id=t.user_id ${where}`, params
    );

    res.json({ success: true, orders: rows, total: parseInt(count), page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  POST /api/admin/orders/:id/retry — retry failed order
// ─────────────────────────────────────────
router.post('/orders/:id/retry', async (req, res) => {
  try {
    const { rows: [txn] } = await db.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (!txn) return res.status(404).json({ success: false, message: 'Order not found' });
    if (txn.status !== 'failed') return res.status(400).json({ success: false, message: 'Only failed orders can be retried' });

    // Increment retry count
    await db.query('UPDATE transactions SET retry_count=retry_count+1, status=$1 WHERE id=$2', ['pending', txn.id]);

    // Re-attempt VTU call based on type
    let result;
    if (txn.type === 'data') {
      const { rows: [plan] } = await db.query('SELECT * FROM data_plans WHERE name=$1 AND network=$2', [txn.plan_name, txn.network]);
      result = await vtuService.buyData({ network: txn.network, phone: txn.phone, plan_code: plan?.api_plan_code, reference: txn.reference + '-R' + txn.retry_count });
    } else if (txn.type === 'airtime') {
      result = await vtuService.buyAirtime({ network: txn.network, phone: txn.phone, amount: txn.amount, reference: txn.reference + '-R' });
    }

    await db.query(`UPDATE transactions SET status='success', vtu_reference=$1, updated_at=NOW() WHERE id=$2`, [result?.vtu_reference, txn.id]);

    logger.info(`Admin retried order ${txn.reference} — success`);
    res.json({ success: true, message: 'Order retried successfully' });
  } catch (err) {
    await db.query(`UPDATE transactions SET status='failed', failure_reason=$1 WHERE id=$2`, [err.message, req.params.id]);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  POST /api/admin/orders/:id/refund
// ─────────────────────────────────────────
router.post('/orders/:id/refund', async (req, res) => {
  try {
    const { rows: [txn] } = await db.query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
    if (!txn) return res.status(404).json({ success: false, message: 'Order not found' });

    if (txn.payment_method === 'wallet') {
      await walletService.refundTransaction({ transaction_id: txn.id, user_id: txn.user_id, amount: txn.amount });
    } else {
      // For card — mark as refunded, handle manually via Paystack dashboard
      await db.query(`UPDATE transactions SET status='refunded', updated_at=NOW() WHERE id=$1`, [txn.id]);
    }

    logger.info(`Admin refunded order ${txn.reference}`);
    res.json({ success: true, message: 'Refund processed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  GET /api/admin/users
// ─────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { page=1, limit=50, status, search } = req.query;
    const offset = (page-1)*limit;
    const conditions = [`u.role='customer'`];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`u.status=$${idx++}`); params.push(status); }
    if (search) {
      conditions.push(`(u.email ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.first_name ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = 'WHERE ' + conditions.join(' AND ');

    const { rows } = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.status, u.created_at,
              w.balance, w.bonus_balance, w.total_funded, w.total_spent,
              (SELECT COUNT(*) FROM transactions t WHERE t.user_id=u.id) AS total_orders
       FROM users u LEFT JOIN wallets w ON w.user_id=u.id
       ${where} ORDER BY u.created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );

    res.json({ success: true, users: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  PATCH /api/admin/users/:id/status — suspend/activate
// ─────────────────────────────────────────
router.patch('/users/:id/status', [
  body('status').isIn(['active','suspended']),
], async (req, res) => {
  try {
    const { status } = req.body;
    await db.query('UPDATE users SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    logger.info(`Admin ${status} user ${req.params.id}`);
    res.json({ success: true, message: `User ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  POST /api/admin/wallets/:user_id/credit
// ─────────────────────────────────────────
router.post('/wallets/:user_id/credit', [
  body('amount').isFloat({ min: 1 }),
  body('description').notEmpty(),
], async (req, res) => {
  try {
    const { amount, description } = req.body;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await walletService.creditWallet(client, { user_id: req.params.user_id, amount, description: `[Admin] ${description}` });
      await client.query('COMMIT');
      logger.info(`Admin credited wallet user=${req.params.user_id} ₦${amount}`);
      res.json({ success: true, message: `₦${amount} credited to wallet` });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  GET /api/admin/data-plans
// ─────────────────────────────────────────
router.get('/data-plans', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM data_plans ORDER BY network, display_order, sell_price');
    res.json({ success: true, plans: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  PATCH /api/admin/data-plans/:id — update price
// ─────────────────────────────────────────
router.patch('/data-plans/:id', [
  body('buy_price').isFloat({ min: 0 }),
  body('sell_price').isFloat({ min: 0 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { buy_price, sell_price, is_active } = req.body;
    await db.query(
      'UPDATE data_plans SET buy_price=$1, sell_price=$2, is_active=$3, updated_at=NOW() WHERE id=$4',
      [buy_price, sell_price, is_active ?? true, req.params.id]
    );
    res.json({ success: true, message: 'Plan updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  GET /api/admin/settings
// ─────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM platform_settings ORDER BY key');
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  PATCH /api/admin/settings — update one or many
// ─────────────────────────────────────────
router.patch('/settings', async (req, res) => {
  try {
    const updates = req.body; // { key: value, key: value }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of Object.entries(updates)) {
        await client.query(
          `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
          [key, String(value)]
        );
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }

    logger.info(`Admin updated settings: ${Object.keys(updates).join(', ')}`);
    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  GET /api/admin/revenue — revenue report
// ─────────────────────────────────────────
router.get('/revenue', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { rows: daily } = await db.query(
      `SELECT DATE(created_at) AS date,
              COUNT(*) AS orders,
              COALESCE(SUM(amount),0) AS revenue,
              COALESCE(SUM(api_cost),0) AS api_cost,
              COALESCE(SUM(profit),0) AS profit
       FROM transactions
       WHERE status='success' AND created_at >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
       GROUP BY DATE(created_at) ORDER BY date DESC`
    );

    const { rows: totals } = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS revenue, COALESCE(SUM(profit),0) AS profit,
              COUNT(*) AS orders
       FROM transactions WHERE status='success'
         AND created_at >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'`
    );

    res.json({ success: true, daily, totals: totals[0], days: parseInt(days) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
//  GET /api/admin/api-status — check VTU API
// ─────────────────────────────────────────
router.get('/api-status', async (req, res) => {
  try {
    const start   = Date.now();
    const balance = await vtuService.checkBalance();
    const ms      = Date.now() - start;
    res.json({ success: true, online: true, response_ms: ms, vtu_balance: balance.balance });
  } catch (err) {
    res.json({ success: true, online: false, error: err.message });
  }
});

module.exports = router;
