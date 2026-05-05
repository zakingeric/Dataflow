-- ─────────────────────────────────────────────────────
--  DataFlow — Database Schema
--  Run: psql -U postgres -d dataflow -f schema.sql
-- ─────────────────────────────────────────────────────

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────
--  USERS
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name      VARCHAR(50)  NOT NULL,
  last_name       VARCHAR(50)  NOT NULL,
  email           VARCHAR(150) NOT NULL UNIQUE,
  phone           VARCHAR(15)  NOT NULL UNIQUE,
  password_hash   TEXT         NOT NULL,
  role            VARCHAR(20)  NOT NULL DEFAULT 'customer',  -- customer | admin
  status          VARCHAR(20)  NOT NULL DEFAULT 'active',    -- active | suspended | unverified
  email_verified  BOOLEAN      DEFAULT FALSE,
  phone_verified  BOOLEAN      DEFAULT FALSE,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────
--  WALLETS
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance         NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  bonus_balance   NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  total_funded    NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  total_spent     NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT wallet_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT wallet_bonus_non_negative   CHECK (bonus_balance >= 0)
);

-- ─────────────────────────
--  TRANSACTIONS
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference       VARCHAR(50)  NOT NULL UNIQUE,  -- e.g. DF1712345678
  user_id         UUID         NOT NULL REFERENCES users(id),
  type            VARCHAR(30)  NOT NULL,  -- data | airtime | bill | tv | exam | wallet_fund | wallet_debit
  network         VARCHAR(20),            -- mtn | airtel | glo | 9mobile
  phone           VARCHAR(15),            -- beneficiary number
  plan_name       VARCHAR(100),           -- e.g. "1GB 30 Days"
  amount          NUMERIC(10,2) NOT NULL, -- amount customer paid
  api_cost        NUMERIC(10,2) DEFAULT 0,-- amount we paid VTU API
  profit          NUMERIC(10,2) DEFAULT 0,-- amount - api_cost
  payment_method  VARCHAR(20)  NOT NULL DEFAULT 'wallet', -- wallet | card
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending | success | failed
  vtu_reference   VARCHAR(100),           -- reference from VTU provider
  paystack_ref    VARCHAR(100),           -- reference from Paystack
  api_response    JSONB,                  -- raw API response stored
  failure_reason  TEXT,
  retry_count     INTEGER DEFAULT 0,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────
--  WALLET LEDGER
--  Every debit/credit on a wallet
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id       UUID         NOT NULL REFERENCES wallets(id),
  user_id         UUID         NOT NULL REFERENCES users(id),
  transaction_id  UUID         REFERENCES transactions(id),
  type            VARCHAR(20)  NOT NULL,  -- credit | debit
  amount          NUMERIC(10,2) NOT NULL,
  balance_before  NUMERIC(12,2) NOT NULL,
  balance_after   NUMERIC(12,2) NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────
--  DATA PLANS (admin manages these)
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS data_plans (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  network         VARCHAR(20)  NOT NULL,  -- mtn | airtel | glo | 9mobile
  name            VARCHAR(50)  NOT NULL,  -- e.g. "1GB"
  size_mb         INTEGER      NOT NULL,  -- in MB
  validity_days   INTEGER      NOT NULL,
  plan_type       VARCHAR(20)  NOT NULL DEFAULT 'sme', -- sme | gifting | corporate
  api_plan_code   VARCHAR(100),           -- code used when calling VTU API
  buy_price       NUMERIC(8,2) NOT NULL,  -- what we pay VTU
  sell_price      NUMERIC(8,2) NOT NULL,  -- what customer pays
  is_active       BOOLEAN      DEFAULT TRUE,
  display_order   INTEGER      DEFAULT 0,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────
--  AIRTIME PRICING (margin per network)
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS airtime_config (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  network         VARCHAR(20)  NOT NULL UNIQUE,
  discount_pct    NUMERIC(5,2) DEFAULT 0,  -- % discount off face value (usually 0 for retail)
  is_active       BOOLEAN      DEFAULT TRUE,
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────
--  BILL PROVIDERS
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS bill_providers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type            VARCHAR(30)  NOT NULL,  -- electricity | water | waste
  name            VARCHAR(100) NOT NULL,  -- e.g. "EKEDC"
  code            VARCHAR(50)  NOT NULL UNIQUE, -- code for VTU API
  description     VARCHAR(200),
  regions         TEXT[],                 -- e.g. {'Lagos', 'Ogun'}
  min_amount      NUMERIC(8,2) DEFAULT 500,
  max_amount      NUMERIC(10,2) DEFAULT 1000000,
  service_charge  NUMERIC(6,2) DEFAULT 0, -- flat fee we add on top
  is_active       BOOLEAN      DEFAULT TRUE,
  display_order   INTEGER      DEFAULT 0
);

-- ─────────────────────────
--  TV PACKAGES
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS tv_packages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider        VARCHAR(30)  NOT NULL,  -- dstv | gotv | startimes
  name            VARCHAR(100) NOT NULL,
  api_code        VARCHAR(50)  NOT NULL,
  buy_price       NUMERIC(8,2) NOT NULL,
  sell_price      NUMERIC(8,2) NOT NULL,
  is_active       BOOLEAN      DEFAULT TRUE,
  display_order   INTEGER      DEFAULT 0
);

-- ─────────────────────────
--  EXAM PRODUCTS
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS exam_products (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(100) NOT NULL,  -- e.g. "WAEC Result Checker"
  exam_type       VARCHAR(30)  NOT NULL,  -- waec | neco | jamb | nabteb
  api_code        VARCHAR(50),
  buy_price       NUMERIC(8,2) NOT NULL,
  sell_price      NUMERIC(8,2) NOT NULL,
  max_quantity    INTEGER      DEFAULT 10,
  is_active       BOOLEAN      DEFAULT TRUE
);

-- ─────────────────────────
--  PAYSTACK PAYMENTS
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS paystack_payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id),
  transaction_id  UUID         REFERENCES transactions(id),
  reference       VARCHAR(100) NOT NULL UNIQUE,
  amount          NUMERIC(10,2) NOT NULL,  -- in naira
  amount_kobo     BIGINT       NOT NULL,   -- in kobo (Paystack unit)
  purpose         VARCHAR(50)  NOT NULL DEFAULT 'wallet_fund', -- wallet_fund | direct_payment
  channel         VARCHAR(30),             -- card | bank_transfer | ussd
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  paystack_data   JSONB,                   -- full webhook payload
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  verified_at     TIMESTAMPTZ
);

-- ─────────────────────────
--  PLATFORM SETTINGS
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  key             VARCHAR(100) PRIMARY KEY,
  value           TEXT,
  description     TEXT,
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────
--  SYSTEM LOGS
-- ─────────────────────────
CREATE TABLE IF NOT EXISTS system_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  level           VARCHAR(10)  NOT NULL,  -- info | warn | error
  event           VARCHAR(100) NOT NULL,
  user_id         UUID         REFERENCES users(id),
  ip_address      INET,
  details         JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────
--  INDEXES (performance)
-- ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_user    ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status  ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_type    ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_wallet ON wallet_ledger(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user   ON wallet_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_data_plans_network   ON data_plans(network, is_active);
CREATE INDEX IF NOT EXISTS idx_paystack_ref         ON paystack_payments(reference);
CREATE INDEX IF NOT EXISTS idx_system_logs_created  ON system_logs(created_at DESC);

-- ─────────────────────────
--  DEFAULT SETTINGS
-- ─────────────────────────
INSERT INTO platform_settings (key, value, description) VALUES
  ('min_wallet_funding',   '100',        'Minimum wallet funding amount in Naira'),
  ('max_wallet_funding',   '500000',     'Maximum wallet funding amount in Naira'),
  ('bonus_on_first_fund',  '150',        'Bonus credit given on first wallet funding'),
  ('maintenance_mode',     'false',      'Set to true to take platform offline'),
  ('data_service_active',  'true',       'Enable/disable data service'),
  ('airtime_service_active','true',      'Enable/disable airtime service'),
  ('bills_service_active', 'true',       'Enable/disable bills service'),
  ('tv_service_active',    'true',       'Enable/disable cable TV service'),
  ('exam_service_active',  'true',       'Enable/disable exam PIN service')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────
--  SEED: Bill Providers
-- ─────────────────────────
INSERT INTO bill_providers (type, name, code, description, regions, min_amount, service_charge) VALUES
  ('electricity', 'EKEDC',  'EKEDC',  'Eko Electricity Distribution Company',        ARRAY['Lagos'],          500, 0),
  ('electricity', 'IKEDC',  'IKEDC',  'Ikeja Electric',                              ARRAY['Lagos'],          500, 0),
  ('electricity', 'AEDC',   'AEDC',   'Abuja Electricity Distribution Company',      ARRAY['Abuja','FCT'],    500, 0),
  ('electricity', 'KEDCO',  'KEDCO',  'Kano Electricity Distribution Company',       ARRAY['Kano'],           500, 0),
  ('electricity', 'PHED',   'PHED',   'Port Harcourt Electricity Distribution',      ARRAY['Rivers','Bayelsa'],500, 0),
  ('electricity', 'EEDC',   'EEDC',   'Enugu Electricity Distribution Company',      ARRAY['Enugu'],          500, 0),
  ('electricity', 'IBEDC',  'IBEDC',  'Ibadan Electricity Distribution Company',     ARRAY['Oyo','Ogun'],     500, 0),
  ('electricity', 'BEDC',   'BEDC',   'Benin Electricity Distribution Company',      ARRAY['Edo','Delta'],    500, 0)
ON CONFLICT DO NOTHING;

-- ─────────────────────────
--  SEED: Airtime Config
-- ─────────────────────────
INSERT INTO airtime_config (network, discount_pct, is_active) VALUES
  ('mtn',     0, true),
  ('airtel',  0, true),
  ('glo',     0, true),
  ('9mobile', 0, true)
ON CONFLICT (network) DO NOTHING;

-- Done!
SELECT 'DataFlow schema created successfully' AS status;
