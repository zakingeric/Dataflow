// services/walletService.js
// All wallet money movements go through here
// Uses DB transactions to prevent double-spend / race conditions
const db     = require('../config/database');
const logger = require('../config/logger');

// ─────────────────────────────────────────
//  Get wallet for a user
// ─────────────────────────────────────────
const getWallet = async (user_id) => {
  const { rows } = await db.query(
    'SELECT * FROM wallets WHERE user_id = $1',
    [user_id]
  );
  if (!rows.length) throw new Error('Wallet not found');
  return rows[0];
};

// ─────────────────────────────────────────
//  Credit wallet (add money)
//  Used for: Paystack funding, admin credit, bonuses
// ─────────────────────────────────────────
const creditWallet = async (client, { user_id, amount, description, transaction_id = null }) => {
  // Lock the wallet row to prevent race conditions
  const { rows: [wallet] } = await client.query(
    'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
    [user_id]
  );
  if (!wallet) throw new Error('Wallet not found');

  const balance_before = parseFloat(wallet.balance);
  const balance_after  = balance_before + parseFloat(amount);

  // Update wallet
  await client.query(
    `UPDATE wallets
     SET balance = $1, total_funded = total_funded + $2, updated_at = NOW()
     WHERE user_id = $3`,
    [balance_after, amount, user_id]
  );

  // Record in ledger
  await client.query(
    `INSERT INTO wallet_ledger
       (wallet_id, user_id, transaction_id, type, amount, balance_before, balance_after, description)
     VALUES ($1, $2, $3, 'credit', $4, $5, $6, $7)`,
    [wallet.id, user_id, transaction_id, amount, balance_before, balance_after, description]
  );

  logger.info(`Wallet credited: user=${user_id} amount=₦${amount} balance=₦${balance_after}`);
  return { balance_before, balance_after, amount };
};

// ─────────────────────────────────────────
//  Debit wallet (remove money)
//  Used for: purchasing services
// ─────────────────────────────────────────
const debitWallet = async (client, { user_id, amount, description, transaction_id = null }) => {
  // Lock the wallet row
  const { rows: [wallet] } = await client.query(
    'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
    [user_id]
  );
  if (!wallet) throw new Error('Wallet not found');

  const balance_before = parseFloat(wallet.balance);

  // Insufficient funds check
  if (balance_before < parseFloat(amount)) {
    throw new Error(`Insufficient wallet balance. Your balance is ₦${balance_before.toLocaleString()}`);
  }

  const balance_after = balance_before - parseFloat(amount);

  // Update wallet
  await client.query(
    `UPDATE wallets
     SET balance = $1, total_spent = total_spent + $2, updated_at = NOW()
     WHERE user_id = $3`,
    [balance_after, amount, user_id]
  );

  // Record in ledger
  await client.query(
    `INSERT INTO wallet_ledger
       (wallet_id, user_id, transaction_id, type, amount, balance_before, balance_after, description)
     VALUES ($1, $2, $3, 'debit', $4, $5, $6, $7)`,
    [wallet.id, user_id, transaction_id, amount, balance_before, balance_after, description]
  );

  logger.info(`Wallet debited: user=${user_id} amount=₦${amount} balance=₦${balance_after}`);
  return { balance_before, balance_after, amount };
};

// ─────────────────────────────────────────
//  Credit bonus wallet
// ─────────────────────────────────────────
const creditBonus = async (client, { user_id, amount, description }) => {
  const { rows: [wallet] } = await client.query(
    'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
    [user_id]
  );
  if (!wallet) throw new Error('Wallet not found');

  await client.query(
    'UPDATE wallets SET bonus_balance = bonus_balance + $1, updated_at = NOW() WHERE user_id = $2',
    [amount, user_id]
  );

  logger.info(`Bonus credited: user=${user_id} amount=₦${amount}`);
};

// ─────────────────────────────────────────
//  Refund a transaction (re-credit wallet)
// ─────────────────────────────────────────
const refundTransaction = async ({ transaction_id, user_id, amount }) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Mark transaction as refunded
    await client.query(
      `UPDATE transactions SET status='refunded', updated_at=NOW() WHERE id=$1`,
      [transaction_id]
    );

    // Credit wallet back
    await creditWallet(client, {
      user_id,
      amount,
      description: `Refund for transaction ${transaction_id}`,
      transaction_id,
    });

    await client.query('COMMIT');
    logger.info(`Refund processed: tx=${transaction_id} user=${user_id} amount=₦${amount}`);
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  getWallet,
  creditWallet,
  debitWallet,
  creditBonus,
  refundTransaction,
};
