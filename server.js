// ─────────────────────────────────────────────────────
//  DataFlow Backend — server.js
//  Main entry point
// ─────────────────────────────────────────────────────
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const rateLimit = require('express-rate-limit');

const logger = console;
const db = { query: async () => true };
// ── Route imports ──
const authRoutes        = require('./routes/auth');
//const userRoutes        = require('./routes/users');
const walletRoutes      = require('./routes/wallet');
const dataRoutes        = require('./routes/data');
//const airtimeRoutes     = require('./routes/airtime');
//const billsRoutes       = require('./routes/bills');
//const tvRoutes          = require('./routes/tv');
//const examRoutes        = require('./routes/exam');
//const transactionRoutes = require('./routes/transactions');
const webhookRoutes     = require('./routes/webhook');
const adminRoutes       = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;
// ─────────────────────────────────────────────────────
//  SECURITY MIDDLEWARE
// ─────────────────────────────────────────────────────
app.use(helmet());

app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://dataflow-ng.netlify.app',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Global rate limiter — 100 requests per 15 min per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ─────────────────────────────────────────────────────
//  BODY PARSING
//  NOTE: Webhook route needs raw body for Paystack signature
// ─────────────────────────────────────────────────────
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) }
}));

// ─────────────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: process.env.PLATFORM_NAME || 'DataFlow',
    timestamp: new Date().toISOString(),
  });
});
// ─────────────────────────────────────────────────────
//  API ROUTES
// ─────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
//app.use('/api/users',        userRoutes);
app.use('/api/wallet',       walletRoutes); 
app.use('/api/data',         dataRoutes);
//app.use('/api/airtime',      airtimeRoutes);
//app.use('/api/bills',        billsRoutes);
//app.use('/api/tv',           tvRoutes);
//app.use('/api/exam',         examRoutes);
//app.use('/api/transactions',  transactionRoutes);
app.use('/api/webhook',      webhookRoutes);
app.use('/api/admin',         adminRoutes);

// ─────────────────────────────────────────────────────
//  404 HANDLER
// ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─────────────────────────────────────────────────────
//  GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`${err.message} — ${req.method} ${req.originalUrl}`);

  // JWT errors
  if (err.name === 'JsonWebTokenError')
    return res.status(401).json({ success: false, message: 'Invalid token' });
  if (err.name === 'TokenExpiredError')
    return res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });

  // Validation errors
  if (err.name === 'ValidationError')
    return res.status(400).json({ success: false, message: err.message });

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
  });
});

// ─────────────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`DataFlow API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

module.exports = app;
