// routes/auth.js
const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const db        = require('../config/database');
const logger    = require('../config/logger');
const { protect } = require('../routes/auth');

const router = express.Router();

// Strict rate limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many attempts. Try again in 15 minutes.' },
});

// ── Helper: sign JWT ──
const signToken = (id, role) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// ── Helper: generate transaction reference ──
const genRef = () => 'DF' + Date.now();

// ─────────────────────────────────────────
//  POST /api/auth/register
// ─────────────────────────────────────────
router.post('/register', authLimiter, [
  body('first_name').trim().notEmpty().withMessage('First name is required'),
  body('last_name').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('phone')
    .matches(/^0[789][01]\d{8}$/)
    .withMessage('Valid Nigerian phone number required (e.g. 08012345678)'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { first_name, last_name, email, phone, password } = req.body;

    // Check existing
    const { rows: existing } = await db.query(
      'SELECT id FROM users WHERE email = $1 OR phone = $2',
      [email, phone]
    );
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'Email or phone already registered.' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Begin transaction
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Create user
      const { rows: [user] } = await client.query(
        `INSERT INTO users (first_name, last_name, email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, 'customer') RETURNING id, first_name, last_name, email, phone, role`,
        [first_name, last_name, email, phone, password_hash]
      );

      // Create wallet for user
      await client.query(
        'INSERT INTO wallets (user_id) VALUES ($1)',
        [user.id]
      );

      await client.query('COMMIT');

      const token = signToken(user.id, user.role);

      logger.info(`New user registered: ${email}`);

      res.status(201).json({
        success: true,
        message: 'Account created successfully',
        token,
        user: {
          id:         user.id,
          first_name: user.first_name,
          last_name:  user.last_name,
          email:      user.email,
          phone:      user.phone,
          role:       user.role,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`Register error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Registration failed. Try again.' });
  }
});

// ─────────────────────────────────────────
//  POST /api/auth/login
// ─────────────────────────────────────────
router.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const { email, password } = req.body;

    const { rows } = await db.query(
      `SELECT u.*, w.balance, w.bonus_balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const user = rows[0];

    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'Account suspended. Contact support.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const token = signToken(user.id, user.role);

    logger.info(`User logged in: ${email}`);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id:            user.id,
        first_name:    user.first_name,
        last_name:     user.last_name,
        email:         user.email,
        phone:         user.phone,
        role:          user.role,
        wallet:        { balance: user.balance || 0, bonus_balance: user.bonus_balance || 0 },
      },
    });
  } catch (err) {
    logger.error(`Login error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Login failed. Try again.' });
  }
});

// ─────────────────────────────────────────
//  GET /api/auth/me  — get current user
// ─────────────────────────────────────────
router.get('/me', protect, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.role, u.status,
              u.email_verified, u.created_at,
              w.balance, w.bonus_balance, w.total_funded, w.total_spent
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const user = rows[0];
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
});

// ─────────────────────────────────────────
//  POST /api/auth/change-password
// ─────────────────────────────────────────
router.post('/change-password', protect, [
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }),
], async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    const new_hash = await bcrypt.hash(new_password, 12);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [new_hash, req.user.id]);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Password change failed' });
  }
});

// ─────────────────────────────────────────
//  PUT /api/auth/profile
// ─────────────────────────────────────────
router.put('/profile', protect, [
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
], async (req, res) => {
  try {
    const { first_name, last_name } = req.body;
    const { rows: [user] } = await db.query(
      `UPDATE users SET first_name=$1, last_name=$2, updated_at=NOW()
       WHERE id=$3 RETURNING id, first_name, last_name, email, phone`,
      [first_name, last_name, req.user.id]
    );
    res.json({ success: true, message: 'Profile updated', user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
});

module.exports = router;
