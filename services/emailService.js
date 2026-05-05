// services/emailService.js
const nodemailer = require('nodemailer');
const logger     = require('../config/logger');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── Base HTML email wrapper ──
const baseTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <style>
    body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 0; }
    .wrap { max-width: 580px; margin: 30px auto; background: #fff; border-radius: 10px; overflow: hidden; }
    .head { background: linear-gradient(135deg, #5b21b6, #7c3aed); padding: 28px 32px; text-align: center; }
    .head h1 { color: #fff; margin: 0; font-size: 1.5rem; }
    .body { padding: 28px 32px; color: #333; line-height: 1.6; }
    .box { background: #f9f6ff; border: 1px solid #e0d4ff; border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
    .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #eee; font-size: 14px; }
    .row:last-child { border-bottom: none; }
    .lbl { color: #666; } .val { font-weight: bold; color: #333; }
    .btn { display: inline-block; background: #7c3aed; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-top: 16px; }
    .foot { text-align: center; padding: 16px; background: #f0f0f0; color: #999; font-size: 12px; }
    .success { color: #059669; font-weight: bold; }
    .fail { color: #dc2626; font-weight: bold; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head"><h1>DataFlow</h1></div>
    <div class="body">${content}</div>
    <div class="foot">© 2025 DataFlow. All rights reserved.<br/>
    If you didn't request this email, please ignore it.</div>
  </div>
</body>
</html>`;

// ── Send helper ──
const send = async ({ to, subject, html }) => {
  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM || 'DataFlow <noreply@dataflow.ng>',
      to,
      subject,
      html,
    });
    logger.info(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    logger.error(`Email send failed to ${to}: ${err.message}`);
    // Don't throw — email failure shouldn't break transaction
  }
};

// ─────────────────────────────────────────
//  Welcome email on registration
// ─────────────────────────────────────────
const sendWelcome = async ({ email, first_name }) => {
  const html = baseTemplate(`
    <h2>Welcome to DataFlow, ${first_name}! 🎉</h2>
    <p>Your account has been created successfully. You can now buy data, airtime, pay electricity bills and more.</p>
    <div class="box">
      <p><strong>What you can do on DataFlow:</strong></p>
      <ul>
        <li>📶 Buy data bundles for all networks</li>
        <li>📱 Buy airtime instantly</li>
        <li>⚡ Pay electricity bills and get tokens</li>
        <li>📺 Renew DSTV, GOtv and Startimes</li>
      </ul>
    </div>
    <p>Fund your wallet or pay directly by card on every transaction.</p>
    <a class="btn" href="${process.env.FRONTEND_URL}">Go to Dashboard</a>
  `);
  await send({ to: email, subject: 'Welcome to DataFlow! 🎉', html });
};

// ─────────────────────────────────────────
//  Wallet funded confirmation
// ─────────────────────────────────────────
const sendWalletFunded = async ({ email, first_name, amount, balance, reference }) => {
  const html = baseTemplate(`
    <h2>Wallet Funded Successfully ✅</h2>
    <p>Hi ${first_name}, your DataFlow wallet has been credited.</p>
    <div class="box">
      <div class="row"><span class="lbl">Amount Added</span><span class="val success">₦${parseFloat(amount).toLocaleString()}</span></div>
      <div class="row"><span class="lbl">New Balance</span><span class="val">₦${parseFloat(balance).toLocaleString()}</span></div>
      <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
    </div>
    <p>You can now use your wallet to buy data, airtime or pay bills.</p>
  `);
  await send({ to: email, subject: `Wallet Funded — ₦${parseFloat(amount).toLocaleString()}`, html });
};

// ─────────────────────────────────────────
//  Transaction success
// ─────────────────────────────────────────
const sendTransactionSuccess = async ({ email, first_name, type, detail, amount, reference, extra = {} }) => {
  const typeLabel = { data: 'Data Purchase', airtime: 'Airtime Top-Up', bill: 'Bill Payment', tv: 'Cable TV', exam: 'Exam PIN' }[type] || 'Transaction';

  let extraRows = '';
  if (extra.token) extraRows += `<div class="row"><span class="lbl">Electricity Token</span><span class="val success">${extra.token}</span></div>`;
  if (extra.units) extraRows += `<div class="row"><span class="lbl">Units</span><span class="val">${extra.units} kWh</span></div>`;
  if (extra.pins)  extraRows += `<div class="row"><span class="lbl">PIN(s)</span><span class="val">${Array.isArray(extra.pins)?extra.pins.join(', '):extra.pins}</span></div>`;

  const html = baseTemplate(`
    <h2>${typeLabel} Successful ✅</h2>
    <p>Hi ${first_name}, your transaction was processed successfully.</p>
    <div class="box">
      <div class="row"><span class="lbl">Service</span><span class="val">${detail}</span></div>
      <div class="row"><span class="lbl">Amount Paid</span><span class="val">₦${parseFloat(amount).toLocaleString()}</span></div>
      ${extraRows}
      <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
      <div class="row"><span class="lbl">Status</span><span class="val success">Successful</span></div>
    </div>
    <p>Thank you for using DataFlow!</p>
  `);
  await send({ to: email, subject: `${typeLabel} Successful — ₦${parseFloat(amount).toLocaleString()}`, html });
};

// ─────────────────────────────────────────
//  Transaction failed
// ─────────────────────────────────────────
const sendTransactionFailed = async ({ email, first_name, type, detail, amount, reference, reason }) => {
  const html = baseTemplate(`
    <h2>Transaction Failed ❌</h2>
    <p>Hi ${first_name}, unfortunately your transaction could not be completed.</p>
    <div class="box">
      <div class="row"><span class="lbl">Service</span><span class="val">${detail}</span></div>
      <div class="row"><span class="lbl">Amount</span><span class="val">₦${parseFloat(amount).toLocaleString()}</span></div>
      <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
      <div class="row"><span class="lbl">Reason</span><span class="val fail">${reason || 'Service unavailable'}</span></div>
    </div>
    <p>If your wallet was debited, it will be refunded within a few minutes. Contact support if you need help.</p>
    <a class="btn" href="${process.env.FRONTEND_URL}/support">Contact Support</a>
  `);
  await send({ to: email, subject: `Transaction Failed — ${detail}`, html });
};

module.exports = {
  sendWelcome,
  sendWalletFunded,
  sendTransactionSuccess,
  sendTransactionFailed,
};
