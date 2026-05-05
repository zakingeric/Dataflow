// routes/webhooks.js
// ⚠️  CRITICAL FILE — handles Paystack payment confirmations
// Raw body parsing is set in server.js for this route
const express         = require('express');
const db              = require('../config/database');
const logger          = require('../config/logger');
const paystackService = require('../services/paystackService');
const walletService   = require('../services/walletService');
const emailService    = require('../services/emailService');

const router = express.Router();

// POST /api/webhooks/paystack
router.post('/paystack', async (req, res) => {
  try {
    // ── Step 1: Verify signature ──
    const signature = req.headers['x-paystack-signature'];
    const isValid   = paystackService.verifyWebhookSignature(req.body, signature);

    if (!isValid) {
      logger.warn('Paystack webhook: invalid signature — rejected');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    // ── Step 2: Parse event ──
    const event = JSON.parse(req.body.toString());
    logger.info(`Paystack webhook received: ${event.event} — ${event.data?.reference}`);

    // ── Step 3: Acknowledge immediately (Paystack requires fast response) ──
    res.status(200).json({ received: true });

    // ── Step 4: Process event (after response sent) ──
    if (event.event === 'charge.success') {
      await handleChargeSuccess(event.data);
    }

  } catch (err) {
    logger.error(`Webhook processing error: ${err.message}`);
    // Still return 200 to Paystack so it doesn't retry
    if (!res.headersSent) res.status(200).json({ received: true });
  }
});

// ─────────────────────────────────────────
//  Handle successful charge
// ─────────────────────────────────────────
async function handleChargeSuccess(data) {
  const { reference, amount: amountKobo, channel, customer, metadata } = data;
  const amount = amountKobo / 100; // convert to naira

  try {
    // Check if already processed (idempotency — very important)
    const { rows: [existing] } = await db.query(
      'SELECT * FROM paystack_payments WHERE reference = $1',
      [reference]
    );

    if (!existing) {
      logger.warn(`Webhook: payment ${reference} not found in DB — possibly initialized elsewhere`);
      return;
    }

    if (existing.status === 'success') {
      logger.info(`Webhook: payment ${reference} already processed — skipping`);
      return;
    }

    // Get user
    const { rows: [user] } = await db.query(
      'SELECT * FROM users WHERE id = $1',
      [existing.user_id]
    );
    if (!user) {
      logger.error(`Webhook: user ${existing.user_id} not found`);
      return;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Mark Paystack payment as success
      await client.query(
        `UPDATE paystack_payments
         SET status='success', channel=$1, paystack_data=$2, verified_at=NOW()
         WHERE reference=$3`,
        [channel, JSON.stringify(data), reference]
      );

      // ── If purpose is wallet_fund → credit the wallet ──
      if (existing.purpose === 'wallet_fund') {

        // Credit wallet
        const walletResult = await walletService.creditWallet(client, {
          user_id:     existing.user_id,
          amount,
          description: `Wallet funded via Paystack (${reference})`,
        });

        // First-time funding bonus
        const { rows: [wallet] } = await client.query(
          'SELECT total_funded FROM wallets WHERE user_id=$1', [existing.user_id]
        );
        const isFirst   = parseFloat(wallet.total_funded) === 0;
        const bonusAmt  = parseFloat(process.env.BONUS_ON_FIRST_FUND || 0);
        if (isFirst && bonusAmt > 0) {
          await walletService.creditBonus(client, {
            user_id:     existing.user_id,
            amount:      bonusAmt,
            description: 'First funding bonus',
          });
        }

        await client.query('COMMIT');

        logger.info(`Webhook: wallet funded — user=${existing.user_id} amount=₦${amount}`);

        // Send email
        emailService.sendWalletFunded({
          email:      user.email,
          first_name: user.first_name,
          amount,
          balance:    walletResult.balance_after,
          reference,
        });
      }

      // ── If purpose is direct_payment → find the pending transaction and fulfill it ──
      if (existing.purpose === 'direct_payment' && existing.transaction_id) {
        await client.query('COMMIT');
        // The service route already handles fulfillment
        // This webhook just confirms payment — fulfillment was triggered in the route
        logger.info(`Webhook: direct payment confirmed — ref=${reference}`);
      }

    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Webhook DB error for ${reference}: ${err.message}`);
    } finally {
      client.release();
    }

  } catch (err) {
    logger.error(`handleChargeSuccess error [${reference}]: ${err.message}`);
  }
}

module.exports = router;
