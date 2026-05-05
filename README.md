# DataFlow Backend API

Production-ready Node.js + Express backend for the DataFlow VTU platform.

---

## Tech Stack

| Layer       | Technology                         |
|-------------|-------------------------------------|
| Runtime     | Node.js 18+                        |
| Framework   | Express.js                         |
| Database    | PostgreSQL 14+                     |
| Auth        | JWT (jsonwebtoken) + bcryptjs      |
| Payments    | Paystack                           |
| VTU API     | VTU.ng / ConnectBridge / Husmo     |
| Email       | Nodemailer (Gmail / SendGrid)      |
| Logging     | Winston                            |
| Security    | Helmet, CORS, express-rate-limit   |

---

## Project Structure

```
backend/
├── server.js                  # Entry point
├── package.json
├── .env.example               # Copy to .env and fill in values
├── config/
│   ├── database.js            # PostgreSQL pool
│   └── logger.js              # Winston logger
├── database/
│   └── schema.sql             # All DB tables + seed data
├── middleware/
│   └── auth.js                # JWT protect + adminOnly guards
├── routes/
│   ├── auth.js                # Register, login, profile
│   ├── users.js               # Customer account
│   ├── wallet.js              # Fund wallet, balance, ledger
│   ├── data.js                # Buy data bundles
│   ├── airtime.js             # Buy airtime
│   ├── bills.js               # Pay electricity bills
│   ├── tv.js                  # Cable TV subscriptions
│   ├── exam.js                # Exam PINs
│   ├── transactions.js        # Transaction history
│   ├── webhooks.js            # Paystack webhook handler ⚠️
│   └── admin.js               # Admin control panel API
├── services/
│   ├── paystackService.js     # Paystack API integration
│   ├── vtuService.js          # VTU provider integration
│   ├── walletService.js       # Wallet debit/credit logic
│   └── emailService.js        # Email notifications
└── logs/                      # Auto-created by Winston
```

---

## Setup Instructions

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# Edit .env with your actual values
```

### 3. Set up PostgreSQL database
```bash
# Create database
psql -U postgres -c "CREATE DATABASE dataflow;"

# Run schema (creates all tables + seed data)
psql -U postgres -d dataflow -f database/schema.sql
```

### 4. Seed data plans (add your plans)
After running schema.sql, add your data plans:
```sql
INSERT INTO data_plans (network, name, size_mb, validity_days, plan_type, api_plan_code, buy_price, sell_price) VALUES
('mtn', '1GB', 1024, 30, 'sme', 'MTN-SME-1GB', 240.00, 300.00),
('mtn', '2GB', 2048, 30, 'sme', 'MTN-SME-2GB', 480.00, 600.00),
('airtel', '1GB', 1024, 30, 'sme', 'AIR-SME-1GB', 256.00, 320.00);
-- Add all your plans here based on your VTU provider's plan codes
```

### 5. Start the server
```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

---

## API Endpoints

### Auth
| Method | Endpoint                    | Description         | Auth |
|--------|-----------------------------|---------------------|------|
| POST   | /api/auth/register          | Create account      | ❌   |
| POST   | /api/auth/login             | Login               | ❌   |
| GET    | /api/auth/me                | Get my profile      | ✅   |
| PUT    | /api/auth/profile           | Update profile      | ✅   |
| POST   | /api/auth/change-password   | Change password     | ✅   |

### Wallet
| Method | Endpoint                        | Description              | Auth |
|--------|---------------------------------|--------------------------|------|
| GET    | /api/wallet                     | Get balance              | ✅   |
| POST   | /api/wallet/fund/initialize     | Start Paystack payment   | ✅   |
| POST   | /api/wallet/fund/verify         | Verify after redirect    | ✅   |
| GET    | /api/wallet/ledger              | Wallet history           | ✅   |

### Services
| Method | Endpoint                  | Description           | Auth |
|--------|---------------------------|-----------------------|------|
| GET    | /api/data/plans           | Get data plans        | ✅   |
| POST   | /api/data/buy             | Buy data bundle       | ✅   |
| POST   | /api/airtime/buy          | Buy airtime           | ✅   |
| GET    | /api/bills/providers      | Get bill providers    | ✅   |
| POST   | /api/bills/pay            | Pay electricity bill  | ✅   |
| GET    | /api/tv/packages          | Get TV packages       | ✅   |
| POST   | /api/tv/subscribe         | Subscribe to TV       | ✅   |
| GET    | /api/exam/products        | Get exam products     | ✅   |
| POST   | /api/exam/buy             | Buy exam PIN          | ✅   |

### Transactions
| Method | Endpoint                      | Description         | Auth |
|--------|-------------------------------|---------------------|------|
| GET    | /api/transactions             | Transaction history | ✅   |
| GET    | /api/transactions/:reference  | Single transaction  | ✅   |

### Webhooks
| Method | Endpoint                  | Description             | Auth |
|--------|---------------------------|-------------------------|------|
| POST   | /api/webhooks/paystack    | Paystack webhook        | 🔒 signature |

### Admin (admin role only)
| Method | Endpoint                        | Description          |
|--------|---------------------------------|----------------------|
| GET    | /api/admin/dashboard            | Stats overview       |
| GET    | /api/admin/orders               | All orders           |
| POST   | /api/admin/orders/:id/retry     | Retry failed order   |
| POST   | /api/admin/orders/:id/refund    | Refund order         |
| GET    | /api/admin/users                | All users            |
| PATCH  | /api/admin/users/:id/status     | Suspend/activate     |
| POST   | /api/admin/wallets/:id/credit   | Credit wallet        |
| GET    | /api/admin/data-plans           | All data plans       |
| PATCH  | /api/admin/data-plans/:id       | Update prices        |
| GET    | /api/admin/settings             | Platform settings    |
| PATCH  | /api/admin/settings             | Update settings      |
| GET    | /api/admin/revenue              | Revenue report       |
| GET    | /api/admin/api-status           | VTU API health       |

---

## Paystack Webhook Setup

1. Log in to your Paystack dashboard
2. Go to Settings → Webhooks
3. Add URL: `https://yourdomain.com/api/webhooks/paystack`
4. Copy the webhook secret into your `.env` as `PAYSTACK_WEBHOOK_SECRET`

> ⚠️ Never skip webhook signature verification. Always verify before processing.

---

## Security Notes

- All passwords hashed with bcrypt (12 rounds)
- JWT tokens expire in 7 days
- Rate limiting on all auth routes (10 req / 15 min)
- Global rate limiting (100 req / 15 min per IP)
- Webhook signature verified on every Paystack event
- Wallet debits use PostgreSQL row-level locking (FOR UPDATE)
- Idempotency checks prevent double-crediting on webhooks
- Failed VTU calls auto-refund wallet payments

---

## Deployment (Render / Railway)

1. Push code to GitHub
2. Create new Web Service on Render
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add all environment variables from `.env`
6. Add a PostgreSQL database and copy the connection string
7. Run schema: connect to DB and run `schema.sql`

---

## VTU API Plan Codes

Each VTU provider has different plan codes. After signing up with your provider:
1. Get the list of plan codes from their documentation or dashboard
2. Update the `api_plan_code` column in `data_plans` table
3. Update the VTU service base URL in `.env`

The `vtuService.js` is provider-agnostic — it just sends the right fields. Adjust the request body shape in `vtuService.js` to match your specific provider's API format.
