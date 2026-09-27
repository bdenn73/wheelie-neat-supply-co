const endpoint = mode => mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function accessToken(env) {
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const response = await fetch(`${endpoint(env.PAYPAL_MODE)}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error('PayPal authentication failed.');
  return data.access_token;
}

export function checkoutReady(env) {
  return !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && ['sandbox', 'live'].includes(env.PAYPAL_MODE));
}

export async function createPayPalOrder(env, { id, name, priceCents, origin }) {
  const token = await accessToken(env);
  const response = await fetch(`${endpoint(env.PAYPAL_MODE)}/v2/checkout/orders`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': id },
    body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ custom_id: id, description: name.slice(0, 127), amount: { currency_code: 'USD', value: (priceCents / 100).toFixed(2) } }], payment_source: { paypal: { experience_context: { return_url: `${origin}/checkout.html`, cancel_url: `${origin}/checkout.html?cancel=1`, user_action: 'PAY_NOW', shipping_preference: 'GET_FROM_FILE' } } } }),
    signal: AbortSignal.timeout(15000)
  });
  const order = await response.json();
  if (!response.ok) {
    const code = /^[A-Z0-9_]{3,64}$/.test(order.name || '') ? order.name : 'API_ERROR';
    const issue = /^[A-Z0-9_]{3,64}$/.test(order.details?.[0]?.issue || '') ? ` / ${order.details[0].issue}` : '';
    const debugId = /^[a-z0-9]{6,32}$/i.test(order.debug_id || '') ? ` (debug ID ${order.debug_id})` : '';
    const error = new Error('PayPal order creation failed.');
    error.ownerMessage = `PayPal returned HTTP ${response.status}: ${code}${issue}${debugId}.`;
    throw error;
  }
  const approval = order.links?.find(link => ['payer-action', 'approve'].includes(link.rel))?.href;
  const host = approval && new URL(approval).hostname;
  if (!order.id || !['www.paypal.com', 'www.sandbox.paypal.com'].includes(host)) throw new Error('PayPal order creation failed.');
  return { paypalId: order.id, approval };
}

export async function capturePayPalOrder(env, { paypalId, id, priceCents }) {
  const token = await accessToken(env);
  const response = await fetch(`${endpoint(env.PAYPAL_MODE)}/v2/checkout/orders/${encodeURIComponent(paypalId)}/capture`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `${id}-capture` },
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  const unit = result.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!response.ok || result.id !== paypalId || result.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' || unit.custom_id !== id || capture.amount?.currency_code !== 'USD' || capture.amount?.value !== (priceCents / 100).toFixed(2)) throw new Error('PayPal capture was not verified.');
  return { captureId: capture.id };
}
