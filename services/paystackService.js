// services/paystackService.js
// All Paystack API interactions live here
const axios  = require('axios');
const crypto = require('crypto');
const logger = require('../config/logger');

const PAYSTACK_BASE = 'https://api.paystack.co';
const SECRET_KEY    = process.env.PAYSTACK_SECRET_KEY;

const paystackAxios = axios.create({
  baseURL: PAYSTACK_BASE,
  headers: {
    Authorization: `Bearer ${SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// ─────────────────────────────────────────
//  Initialize a payment (wallet fund or direct pay)
// ─────────────────────────────────────────
const initializePayment = async ({ email, amount, reference, metadata = {}, callback_url }) => {
  try {
    const { data } = await paystackAxios.post('/transaction/initialize', {
      email,
      amount:       Math.round(amount * 100), // convert to kobo
      reference,
      metadata,
      callback_url: callback_url || process.env.PAYSTACK_CALLBACK_URL,
      channels:     ['card', 'bank_transfer', 'ussd', 'bank'],
    });

    logger.info(`Paystack payment initialized: ${reference} — ₦${amount}`);
    return { success: true, data: data.data };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error(`Paystack init failed: ${msg}`);
    throw new Error(`Payment initialization failed: ${msg}`);
  }
};

// ─────────────────────────────────────────
//  Verify a transaction by reference
// ─────────────────────────────────────────
const verifyPayment = async (reference) => {
  try {
    const { data } = await paystackAxios.get(`/transaction/verify/${reference}`);
    const txn = data.data;

    logger.info(`Paystack verify: ${reference} — status: ${txn.status}`);

    return {
      success:  true,
      verified: txn.status === 'success',
      amount:   txn.amount / 100, // convert back to naira
      channel:  txn.channel,
      data:     txn,
    };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error(`Paystack verify failed: ${msg}`);
    throw new Error(`Payment verification failed: ${msg}`);
  }
};

// ─────────────────────────────────────────
//  Verify Paystack webhook signature
//  Call this BEFORE processing any webhook
// ─────────────────────────────────────────
const verifyWebhookSignature = (rawBody, signature) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  return hash === signature;
};

// ─────────────────────────────────────────
//  Get transaction list (for admin)
// ─────────────────────────────────────────
const listTransactions = async ({ page = 1, perPage = 50 } = {}) => {
  try {
    const { data } = await paystackAxios.get('/transaction', {
      params: { page, perPage },
    });
    return { success: true, data: data.data };
  } catch (err) {
    throw new Error(err.response?.data?.message || err.message);
  }
};

module.exports = {
  initializePayment,
  verifyPayment,
  verifyWebhookSignature,
  listTransactions,
};
