// services/vtuService.js
// ─────────────────────────────────────────────────────
//  IACafe VTU API Integration
//  Base URL: https://iacafe.com.ng/devapi/v1
//  Auth:     Authorization: Bearer YOUR_API_KEY
//  Docs:     https://iacafe.com.ng/developer
// ─────────────────────────────────────────────────────
const axios  = require('axios');
const logger = require('../config/logger');

const BASE_URL = 'https://iacafe.com.ng/devapi/v1';

const iacafe = axios.create({
  baseURL:  BASE_URL,
  timeout:  30000,
  headers: {
    'Authorization': `Bearer ${process.env.VTU_API_KEY}`,
    'Content-Type':  'application/json',
  },
});

// ─────────────────────────────────────────
//  Helper: generate unique request_id
//  IACafe requires unique request_id per transaction
//  to prevent duplicate processing (409 Conflict)
// ─────────────────────────────────────────
const makeRequestId = (prefix) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

// ─────────────────────────────────────────
//  Helper: parse IACafe response
//  Success:  { code: "success", data: { status: "completed-api"|"processing-api", ... } }
//  Error:    { success: false, error: { code: "...", message: "..." } }
// ─────────────────────────────────────────
const parseResponse = (data, reference) => {
  if (data.code === 'success') {
    const status = data.data?.status;
    // completed-api = done, processing-api = async (wait for webhook)
    return {
      success:       true,
      completed:     status === 'completed-api',
      processing:    status === 'processing-api',
      order_id:      data.data?.order_id,
      vtu_reference: String(data.data?.order_id || reference),
      raw:           data.data,
    };
  }
  // Error response
  const errMsg = data.error?.message || data.message || 'VTU request failed';
  throw new Error(errMsg);
};

// ─────────────────────────────────────────
//  GET VARIATIONS (data plans / TV packages)
//  GET /devapi/v1/variations?product=data&service_id=mtn
// ─────────────────────────────────────────
const getVariations = async (product, service_id) => {
  try {
    const { data } = await iacafe.get('/variations', {
      params: { product, service_id },
    });
    if (data.code !== 'success') throw new Error(data.message || 'Failed to get variations');
    return data.data; // array of { variation_id, name, price }
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`IACafe getVariations failed [${product}/${service_id}]: ${msg}`);
    throw new Error(msg);
  }
};

// ─────────────────────────────────────────
//  VERIFY CUSTOMER (meter/smartcard validation)
//  POST /devapi/v1/verify-customer
//  ⚠️  Always call this before electricity/TV purchases
// ─────────────────────────────────────────
const verifyCustomer = async ({ customer_id, service_id, variation_id }) => {
  try {
    logger.info(`IACafe verifyCustomer: ${service_id} — ${customer_id}`);
    const { data } = await iacafe.post('/verify-customer', {
      customer_id,
      service_id,
      variation_id,
    });
    if (data.code !== 'success') throw new Error(data.message || 'Verification failed');
    return {
      success:       true,
      customer_name: data.data?.customer_name,
      address:       data.data?.customer_address,
      raw:           data.data,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`IACafe verifyCustomer failed: ${msg}`);
    throw new Error(`Customer verification failed: ${msg}`);
  }
};

// ─────────────────────────────────────────
//  BUY DATA
//  POST /devapi/v1/data
//  Required: request_id, phone, service_id, variation_id
//  Note: NO amount field needed — price set by variation_id
// ─────────────────────────────────────────
const buyData = async ({ network, phone, plan_code, reference }) => {
  try {
    const request_id = reference || makeRequestId(`data_${network}`);
    logger.info(`IACafe buyData: ${network} plan=${plan_code} → ${phone} [${request_id}]`);

    const { data } = await iacafe.post('/data', {
      request_id,
      phone,
      service_id:   network.toLowerCase(),  // mtn | airtel | glo | 9mobile
      variation_id: plan_code,               // from data_plans.api_plan_code
    });

    const result = parseResponse(data, request_id);
    logger.info(`IACafe buyData ${result.completed ? 'completed' : 'processing'}: ${request_id} — order_id: ${result.order_id}`);
    return {
      ...result,
      message: result.completed ? 'Data activated successfully' : 'Data order is processing',
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`IACafe buyData failed [${reference}]: ${msg}`);
    throw new Error(msg);
  }
};

// ─────────────────────────────────────────
//  BUY AIRTIME
//  POST /devapi/v1/airtime
//  Required: request_id, phone, service_id, amount
// ─────────────────────────────────────────
const buyAirtime = async ({ network, phone, amount, reference }) => {
  try {
    const request_id = reference || makeRequestId(`air_${network}`);
    logger.info(`IACafe buyAirtime: ${network} ₦${amount} → ${phone} [${request_id}]`);

    const { data } = await iacafe.post('/airtime', {
      request_id,
      phone,
      service_id: network.toLowerCase(), // mtn | airtel | glo | 9mobile
      amount:     parseFloat(amount),
    });

    const result = parseResponse(data, request_id);
    logger.info(`IACafe buyAirtime ${result.completed ? 'completed' : 'processing'}: ${request_id}`);
    return {
      ...result,
      message: result.completed ? 'Airtime sent successfully' : 'Airtime order is processing',
      discount: data.data?.discount,
      amount_charged: data.data?.amount_charged,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`IACafe buyAirtime failed [${reference}]: ${msg}`);
    throw new Error(msg);
  }
};

// ─────────────────────────────────────────
//  PAY ELECTRICITY
//  POST /devapi/v1/electricity
//  Required: request_id, customer_id (meter), service_id, variation_id, amount
//
//  IACafe service_id mapping:
//  EKEDC  → eko-electric
//  IKEDC  → ikeja-electric
//  AEDC   → abuja-electric
//  KEDCO  → kano-electric
//  PHED   → portharcourt-electric
//  IBEDC  → ibadan-electric
//  KAEDCO → kaduna-electric
//  JED    → jos-electric
//  EEDC   → enugu-electric
//  BEDC   → benin-electric
//  ABA    → aba-electric
//  YEDC   → yola-electric
// ─────────────────────────────────────────
const DISCO_MAP = {
  'EKEDC':  'eko-electric',
  'IKEDC':  'ikeja-electric',
  'AEDC':   'abuja-electric',
  'KEDCO':  'kano-electric',
  'PHED':   'portharcourt-electric',
  'IBEDC':  'ibadan-electric',
  'KAEDCO': 'kaduna-electric',
  'JED':    'jos-electric',
  'EEDC':   'enugu-electric',
  'BEDC':   'benin-electric',
  'ABA':    'aba-electric',
  'YEDC':   'yola-electric',
};

const payElectricity = async ({ provider_code, meter_number, meter_type, amount, phone, reference }) => {
  try {
    const request_id  = reference || makeRequestId('elec');
    const service_id  = DISCO_MAP[provider_code.toUpperCase()] || provider_code;
    const variation_id = meter_type?.toLowerCase() === 'postpaid' ? 'postpaid' : 'prepaid';

    logger.info(`IACafe electricity: ${service_id} meter=${meter_number} ₦${amount} [${request_id}]`);

    const { data } = await iacafe.post('/electricity', {
      request_id,
      customer_id:  meter_number,
      service_id,
      variation_id,
      amount:       parseFloat(amount),
    });

    const result = parseResponse(data, request_id);
    logger.info(`IACafe electricity ${result.completed ? 'completed' : 'processing'}: token=${data.data?.token}`);

    return {
      ...result,
      message:       result.completed ? 'Electricity token generated' : 'Electricity payment is processing',
      token:         data.data?.token,
      units:         data.data?.units,
      customer_name: data.data?.customer_name,
      band:          data.data?.band,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`IACafe electricity failed [${reference}]: ${msg}`);
    throw new Error(msg);
  }
};

// ─────────────────────────────────────────
//  PAY CABLE TV
//  POST /devapi/v1/cable
//  Required: request_id, customer_id (smartcard), service_id, variation_id
//  service_id: dstv | gotv | startimes | showmax
// ─────────────────────────────────────────
const payCableTV = async ({ provider, smartcard_number, package_code, reference }) => {
  try {
    const request_id = reference || makeRequestId(`cable_${provider}`);
    logger.info(`IACafe cable: ${provider} smartcard=${smartcard_number} pkg=${package_code} [${request_id}]`);

    const { data } = await iacafe.post('/cable', {
      request_id,
      customer_id:  smartcard_number,
      service_id:   provider.toLowerCase(), // dstv | gotv | startimes | showmax
      variation_id: package_code,           // from tv_packages.api_code
    });

    const result = parseResponse(data, request_id);
    logger.info(`IACafe cable ${result.completed ? 'completed' : 'processing'}: ${request_id}`);
    return {
      ...result,
      message:           result.completed ? 'Subscription renewed successfully' : 'Subscription is processing',
      customer_name:     data.data?.customer_name,
      bouquet:           data.data?.bouquet,
      subscription_type: data.data?.subscription_type,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`IACafe cable failed [${reference}]: ${msg}`);
    throw new Error(msg);
  }
};

// ─────────────────────────────────────────
//  BUY EXAM PIN (ePINs)
//  POST /devapi/v1/epins
// ─────────────────────────────────────────
const buyExamPin = async ({ exam_type, quantity, phone, reference }) => {
  try {
    const request_id = reference || makeRequestId('epin');
    logger.info(`IACafe epin: ${exam_type} x${quantity} [${request_id}]`);

    const { data } = await iacafe.post('/epins', {
      request_id,
      service_id: exam_type, // waec | neco | jamb | nabteb
      quantity:   parseInt(quantity),
      phone,
    });

    const result = parseResponse(data, request_id);
    logger.info(`IACafe epin completed: ${request_id}`);
    return {
      ...result,
      message: 'Exam PIN(s) purchased successfully',
      pins:    data.data?.pins || data.data?.pin,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`IACafe epin failed [${reference}]: ${msg}`);
    throw new Error(msg);
  }
};

// ─────────────────────────────────────────
//  REQUERY ORDER (check transaction status)
//  GET /devapi/v1/orders/:order_id
//  Use this when status = "processing-api"
//  or when webhook hasn't arrived after 30 seconds
// ─────────────────────────────────────────
const requeryOrder = async (order_id) => {
  try {
    logger.info(`IACafe requery: order_id=${order_id}`);
    const { data } = await iacafe.get(`/orders/${order_id}`);
    return {
      success:   data.code === 'success',
      status:    data.data?.status,
      completed: data.data?.status === 'completed-api',
      raw:       data.data,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`IACafe requery failed [${order_id}]: ${msg}`);
    throw new Error(msg);
  }
};

// ─────────────────────────────────────────
//  CHECK WALLET BALANCE on IACafe
// ─────────────────────────────────────────
const checkBalance = async () => {
  try {
    const { data } = await iacafe.get('/balance');
    return { success: true, balance: data.balance || data.data?.balance };
  } catch (err) {
    logger.error(`IACafe balance check failed: ${err.message}`);
    throw new Error('Could not fetch IACafe balance');
  }
};

module.exports = {
  getVariations,
  verifyCustomer,
  buyData,
  buyAirtime,
  payElectricity,
  payCableTV,
  buyExamPin,
  requeryOrder,
  checkBalance,
  DISCO_MAP,
};
