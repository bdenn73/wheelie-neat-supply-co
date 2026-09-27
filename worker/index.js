// Cloudflare Workers version of the catalog API. Static files live in /frontend.
import { validateMessages, reply, cloudflareReply } from './aria.js';
import { searchCJ } from './cj.js';
import { checkoutReady, createPayPalOrder, capturePayPalOrder } from './paypal.js';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
function hardened(response) {
  const copy = new Response(response.body, response);
  copy.headers.set('X-Content-Type-Options', 'nosniff');
  copy.headers.set('X-Frame-Options', 'DENY');
  copy.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  copy.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return copy;
}
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));

function sessionId(request) {
  return /(?:^|;\s*)wn_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie') || '')?.[1];
}
function originAllowed(request) {
  try { return new URL(request.headers.get('Origin')).origin === new URL(request.url).origin; }
  catch { return false; }
}
async function body(request) {
  const size = Number(request.headers.get('Content-Length') || 0);
  if (size > 10000) throw new Error('Request too large.');
  const value = await request.text();
  if (value.length > 10000) throw new Error('Request too large.');
  try { return JSON.parse(value); } catch { throw new Error('Invalid JSON.'); }
}
function validate(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  const price = String(input?.price);
  if (!name || name.length > 100 || description.length > 500 || !/^\d+(\.\d{1,2})?$/.test(price) || Number(price) < 0.01 || Number(price) > 100000) throw new Error('Enter a name and a valid price.');
  const sku = typeof input?.sku === 'string' ? input.sku.trim() : '';
  const supplier = typeof input?.supplier === 'string' ? input.supplier.trim() : '';
  if (sku.length > 80 || supplier.length > 150) throw new Error('SKU or supplier is too long.');
  const money = (value, label) => {
    if (value === '' || value === undefined || value === null) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(String(value)) || Number(value) > 100000) throw new Error(`Enter a valid ${label}.`);
    return Math.round(Number(value) * 100);
  };
  const stock = input?.stockQty;
  if (stock !== '' && stock !== undefined && stock !== null && (!/^\d+$/.test(String(stock)) || Number(stock) > 1000000)) throw new Error('Enter a valid stock quantity.');
  return { name, description, priceCents: Math.round(Number(price) * 100), available: input.available === true,
    sku, supplier, unitCostCents: money(input.unitCost, 'unit cost'), shippingCostCents: money(input.shippingCost, 'shipping cost'),
    stockQty: stock === '' || stock === undefined || stock === null ? null : Number(stock) };
}
const mapProduct = row => ({ id: row.id, name: row.name, description: row.description, priceCents: row.price_cents, available: row.available === 1 });
async function detailsTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS product_details (product_id TEXT PRIMARY KEY, sku TEXT NOT NULL DEFAULT \'\', supplier TEXT NOT NULL DEFAULT \'\', unit_cost_cents INTEGER, shipping_cost_cents INTEGER, stock_qty INTEGER)').run();
}
async function saveDetails(db, item) {
  await db.prepare('INSERT INTO product_details (product_id, sku, supplier, unit_cost_cents, shipping_cost_cents, stock_qty) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET sku = excluded.sku, supplier = excluded.supplier, unit_cost_cents = excluded.unit_cost_cents, shipping_cost_cents = excluded.shipping_cost_cents, stock_qty = excluded.stock_qty')
    .bind(item.id, item.sku, item.supplier, item.unitCostCents, item.shippingCostCents, item.stockQty).run();
}
async function securityTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS security_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_hash TEXT, created_at INTEGER NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
}
async function ordersTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, paypal_id TEXT UNIQUE NOT NULL, product_id TEXT NOT NULL, price_cents INTEGER NOT NULL, status TEXT NOT NULL, capture_id TEXT, created_at INTEGER NOT NULL)").run();
}
async function signalsTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS market_signals (id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT, supplier_price TEXT, keyword TEXT NOT NULL, observed_at INTEGER NOT NULL)").run();
}
async function signals(db) {
  await signalsTable(db);
  return (await db.prepare('SELECT id, name, sku, supplier_price AS supplierPrice, keyword, observed_at AS observedAt FROM market_signals ORDER BY observed_at DESC LIMIT 30').all()).results;
}
async function scanSupplier(env) {
  if (!env.DB || !env.CJ_API_KEY) return;
  const keywords = ['storage organizer', 'desk organizer', 'utility tools'];
  const keyword = keywords[Math.floor(Date.now() / 86400000) % keywords.length];
  const candidates = await searchCJ(env.CJ_API_KEY, keyword, true);
  await signalsTable(env.DB);
  const observed = Date.now();
  for (const item of candidates) {
    if (!item.id || !item.name) continue;
    await env.DB.prepare('INSERT INTO market_signals (id, name, sku, supplier_price, keyword, observed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, sku = excluded.sku, supplier_price = excluded.supplier_price, keyword = excluded.keyword, observed_at = excluded.observed_at')
      .bind(item.id, item.name, item.sku, item.supplierPrice, keyword, observed).run();
  }
  await env.DB.prepare('DELETE FROM market_signals WHERE observed_at < ?').bind(observed - 30 * 86400000).run();
}
async function locked(db) {
  await securityTable(db);
  const state = await db.prepare('SELECT value FROM operations WHERE key = ?').bind('lockdown').first();
  return state?.value === 'on';
}
async function products(db, publicOnly = false) {
  if (publicOnly) {
    await detailsTable(db);
    return (await db.prepare('SELECT p.id, p.name, p.description, p.price_cents, p.available FROM products p LEFT JOIN product_details d ON d.product_id = p.id WHERE p.available = 1 AND (d.stock_qty IS NULL OR d.stock_qty > 0) ORDER BY p.rowid DESC').all()).results.map(mapProduct);
  }
  await detailsTable(db);
  const rows = (await db.prepare('SELECT p.id, p.name, p.description, p.price_cents, p.available, d.sku, d.supplier, d.unit_cost_cents, d.shipping_cost_cents, d.stock_qty FROM products p LEFT JOIN product_details d ON d.product_id = p.id ORDER BY p.rowid DESC').all()).results;
  return rows.map(row => ({ ...mapProduct(row), sku: row.sku || '', supplier: row.supplier || '', unitCostCents: row.unit_cost_cents ?? null, shippingCostCents: row.shipping_cost_cents ?? null, stockQty: row.stock_qty ?? null }));
}
function suggestedPrice(input) {
  const cost = Number(input?.unitCostCents);
  const shipping = Number(input?.shippingCostCents || 0);
  const margin = Number(input?.targetMargin);
  if (!Number.isInteger(cost) || cost < 1 || !Number.isInteger(shipping) || shipping < 0 || !Number.isFinite(margin) || margin < 5 || margin > 70) throw new Error('Enter a unit cost and target margin from 5% to 70%.');
  // Estimate domestic PayPal Checkout at 3.49% plus $0.49 per transaction.
  // Keep the assumption visible to the owner; rates vary by payment method and location.
  return Math.ceil((cost + shipping + 49) / (1 - margin / 100 - 0.0349));
}
async function authenticated(db, request) {
  const id = sessionId(request);
  if (!id) return null;
  const row = await db.prepare('SELECT expires_at FROM sessions WHERE id = ?').bind(id).first();
  return row && row.expires_at > Date.now() ? id : null;
}
const cookie = (id, age) => `wn_session=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;

async function api(request, env, path) {
  const db = env.DB;
  if (!db) return json({ error: 'Database is not configured.' }, 503);
  if (request.method === 'GET' && path === '/api/products') {
    const isLocked = await locked(db);
    return json(isLocked ? [] : await products(db, true), 200, { 'X-Catalog-Lockdown': isLocked ? 'on' : 'off' });
  }
  if (request.method === 'GET' && path === '/api/checkout/status') return json({ live: false, sandbox: env.PAYPAL_MODE === 'sandbox' && checkoutReady(env) });
  if (request.method === 'GET' && path === '/api/admin/session') return json({
    authenticated: !!(await authenticated(db, request)), configured: !!env.ADMIN_PASSWORD, ariaConfigured: !!(env.AI || env.OPENAI_API_KEY), supplierConfigured: !!env.CJ_API_KEY
  });
  if (request.method !== 'GET' && !originAllowed(request)) return json({ error: 'Invalid request origin.' }, 403);
  if (request.method === 'POST' && path === '/api/admin/login') {
    if (!env.ADMIN_PASSWORD) return json({ error: 'Owner login is not configured.' }, 503);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const prior = await db.prepare('SELECT count, expires_at FROM login_attempts WHERE ip = ?').bind(ip).first();
    if (prior?.count >= 5 && prior.expires_at > now) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    const input = await body(request);
    const entered = await digest(typeof input?.password === 'string' ? input.password : '');
    const expected = await digest(env.ADMIN_PASSWORD);
    let difference = 0;
    for (let i = 0; i < entered.length; i++) difference |= entered.charCodeAt(i) ^ expected.charCodeAt(i);
    if (difference) {
      await db.prepare('INSERT INTO login_attempts (ip, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at')
        .bind(ip, prior?.expires_at > now ? prior.count + 1 : 1, now + 900000).run();
      await securityTable(db);
      await db.prepare('INSERT INTO security_events (id, kind, actor_hash, created_at) VALUES (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), 'failed_login', await digest(ip + ':' + env.ADMIN_PASSWORD), now).run();
      return json({ error: 'Incorrect password.' }, 401);
    }
    await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
    const id = random();
    await db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').bind(id, now + 43200000).run();
    return json({ authenticated: true }, 200, { 'Set-Cookie': cookie(id, 43200) });
  }
  if (request.method === 'POST' && path === '/api/admin/logout') {
    const id = sessionId(request);
    if (id) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return json({ authenticated: false }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (request.method === 'POST' && path === '/api/checkout/sandbox/create') {
    if (!await authenticated(db, request)) return json({ error: 'Owner sign-in required for sandbox checkout.' }, 401);
    if (env.PAYPAL_MODE !== 'sandbox' || !checkoutReady(env)) return json({ error: 'PayPal sandbox credentials are not configured.' }, 503);
    if (await locked(db)) return json({ error: 'Catalog lockdown is on.' }, 423);
    const input = await body(request);
    if (typeof input?.productId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.productId)) return json({ error: 'Choose a product.' }, 400);
    const product = await db.prepare('SELECT id, name, price_cents, available FROM products WHERE id = ?').bind(input.productId).first();
    if (!product) return json({ error: 'This product is unavailable.' }, 409);
    await detailsTable(db);
    const detail = await db.prepare('SELECT stock_qty FROM product_details WHERE product_id = ?').bind(product.id).first();
    if (detail?.stock_qty === 0) return json({ error: 'This product is out of stock.' }, 409);
    const orderId = crypto.randomUUID();
    try {
      const result = await createPayPalOrder(env, { id: orderId, name: product.name, priceCents: product.price_cents, origin: new URL(request.url).origin });
      await ordersTable(db);
      await db.prepare('INSERT INTO orders (id, paypal_id, product_id, price_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(orderId, result.paypalId, product.id, product.price_cents, 'created', Date.now()).run();
      return json({ approval: result.approval, orderId }, 201);
    } catch (error) {
      console.error('Sandbox checkout create:', error.ownerMessage || error.message);
      return json({ error: error.message === 'PayPal authentication failed.'
        ? 'PayPal sandbox authentication failed. Check that the Client ID and Secret in Cloudflare are from the same sandbox app.'
        : error.ownerMessage || 'PayPal sandbox could not create an order. Try again or check the Worker logs.' }, 502);
    }
  }
  if (request.method === 'POST' && path === '/api/checkout/sandbox/capture') {
    if (!await authenticated(db, request)) return json({ error: 'Owner sign-in required for sandbox checkout.' }, 401);
    if (env.PAYPAL_MODE !== 'sandbox' || !checkoutReady(env)) return json({ error: 'PayPal sandbox credentials are not configured.' }, 503);
    const input = await body(request);
    if (typeof input?.token !== 'string' || !/^[A-Za-z0-9-]{5,64}$/.test(input.token)) return json({ error: 'Invalid PayPal order token.' }, 400);
    await ordersTable(db);
    const order = await db.prepare('SELECT id, paypal_id, price_cents, status FROM orders WHERE paypal_id = ?').bind(input.token).first();
    if (!order) return json({ error: 'Order not found.' }, 404);
    if (order.status === 'completed') return json({ status: 'completed', orderId: order.id });
    try {
      const capture = await capturePayPalOrder(env, { paypalId: order.paypal_id, id: order.id, priceCents: order.price_cents });
      await db.prepare('UPDATE orders SET status = ?, capture_id = ? WHERE id = ? AND status = ?').bind('completed', capture.captureId, order.id, 'created').run();
      return json({ status: 'completed', orderId: order.id });
    } catch (error) { console.error('Sandbox checkout capture:', error.message); return json({ error: 'PayPal sandbox capture could not be verified.' }, 502); }
  }
  const id = await authenticated(db, request);
  if (!id) return json({ error: 'Sign in to manage products.' }, 401);
  if (request.method === 'GET' && path === '/api/admin/orders') {
    await ordersTable(db);
    return json((await db.prepare('SELECT o.id, o.price_cents, o.status, o.created_at, p.name AS product_name FROM orders o LEFT JOIN products p ON p.id = o.product_id ORDER BY o.created_at DESC LIMIT 50').all()).results);
  }
  if (request.method === 'GET' && path === '/api/admin/scout') return json({ source: 'CJdropshipping trending catalog flag', candidates: await signals(db) });
  if (request.method === 'GET' && path === '/api/admin/supplier/search') {
    if (!env.CJ_API_KEY) return json({ error: 'Add the CJ_API_KEY secret in Cloudflare to search CJ products.' }, 503);
    await db.prepare('CREATE TABLE IF NOT EXISTS supplier_usage (session_id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)').run();
    const now = Date.now();
    const usage = await db.prepare('SELECT count, expires_at FROM supplier_usage WHERE session_id = ?').bind(id).first();
    if (usage?.count >= 20 && usage.expires_at > now) return json({ error: 'Supplier search limit reached for this hour.' }, 429);
    await db.prepare('INSERT INTO supplier_usage (session_id, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at')
      .bind(id, usage?.expires_at > now ? usage.count + 1 : 1, usage?.expires_at > now ? usage.expires_at : now + 3600000).run();
    try { return json({ products: await searchCJ(env.CJ_API_KEY, new URL(request.url).searchParams.get('q')) }); }
    catch (error) { if (error.message.startsWith('Enter a supplier search')) return json({ error: error.message }, 400); console.error('Supplier search:', error.message); return json({ error: 'Supplier search unavailable. Check the CJ connection and try later.' }, 502); }
  }
  if (request.method === 'GET' && path === '/api/admin/security') {
    const isLocked = await locked(db);
    const since = Date.now() - 7 * 86400000;
    const attempts = await db.prepare('SELECT count(*) AS count FROM security_events WHERE kind = ? AND created_at > ?').bind('failed_login', since).first();
    return json({ lockdown: isLocked, failedLogins7d: attempts?.count || 0 });
  }
  if (request.method === 'POST' && path === '/api/admin/security/lockdown') {
    const input = await body(request);
    if (typeof input?.lockdown !== 'boolean') throw new Error('Choose whether lockdown is on or off.');
    await securityTable(db);
    await db.prepare('INSERT INTO operations (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('lockdown', input.lockdown ? 'on' : 'off').run();
    await db.prepare('INSERT INTO security_events (id, kind, actor_hash, created_at) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), input.lockdown ? 'lockdown_on' : 'lockdown_off', null, Date.now()).run();
    return json({ lockdown: input.lockdown });
  }
  if (request.method === 'POST' && (path === '/api/admin/aria' || path === '/api/admin/aria/draft')) {
    if (!env.AI && !env.OPENAI_API_KEY) return json({ error: 'Aria is not configured yet.' }, 503);
    const now = Date.now();
    const usage = await db.prepare('SELECT count, expires_at FROM aria_usage WHERE session_id = ?').bind(id).first();
    if (usage?.count >= 20 && usage.expires_at > now) return json({ error: 'Aria has reached the hourly limit. Please try later.' }, 429);
    const input = await body(request);
    const draft = path.endsWith('/draft');
    const priceCents = draft && input?.unitCostCents != null ? suggestedPrice(input) : null;
    const messages = draft ? validateMessages([{ role: 'user', content: `Draft a factual, concise product listing description (max 500 characters) using only these owner-provided facts. Return the description alone. If facts are sparse, keep it short. Do not invent specifications, benefits, supplier claims, availability or shipping terms. Product: ${JSON.stringify({ name: String(input?.name || '').slice(0, 100), sku: String(input?.sku || '').slice(0, 80), notes: String(input?.notes || '').slice(0, 500) })}` }]) : validateMessages(input?.messages);
    if (draft && (!String(input?.name || '').trim() || String(input.name).length > 100)) throw new Error('Enter a product name first.');
    await db.prepare('INSERT INTO aria_usage (session_id, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at')
      .bind(id, usage?.expires_at > now ? usage.count + 1 : 1, usage?.expires_at > now ? usage.expires_at : now + 3600000).run();
    try {
      const catalog = await products(db);
      const marketSignals = await signals(db);
      const response = env.AI ? await cloudflareReply({ ai: env.AI, messages, catalog, marketSignals }) : await reply({ messages, catalog, marketSignals, key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });
      return json(draft ? { description: response.slice(0, 500), priceCents, pricingNote: priceCents === null ? 'Add a unit cost to calculate a price.' : `Suggested price uses entered cost, shipping, an estimated domestic PayPal Checkout fee (3.49% + $0.49), and ${input.targetMargin}% target margin. Other fees, taxes, returns and overhead are excluded. Review before publishing.` } : { reply: response });
    } catch (error) { console.error('Aria request:', error.message); return json({ error: 'Aria could not reply right now. The free AI allowance may be exhausted; please try later.' }, 502); }
  }
  if (request.method === 'GET' && path === '/api/admin/products') return json(await products(db));
  if (request.method === 'POST' && path === '/api/admin/products') {
    const item = { id: crypto.randomUUID(), ...validate(await body(request)) };
    await detailsTable(db);
    await db.prepare('INSERT INTO products (id, name, description, price_cents, available) VALUES (?, ?, ?, ?, ?)')
      .bind(item.id, item.name, item.description, item.priceCents, Number(item.available)).run();
    await saveDetails(db, item);
    return json(item, 201);
  }
  const match = /^\/api\/admin\/products\/([a-f0-9-]{36})$/.exec(path);
  if (match && (request.method === 'PUT' || request.method === 'DELETE')) {
    const existing = await db.prepare('SELECT id FROM products WHERE id = ?').bind(match[1]).first();
    if (!existing) return json({ error: 'Product not found.' }, 404);
    if (request.method === 'DELETE') { await detailsTable(db); await db.prepare('DELETE FROM product_details WHERE product_id = ?').bind(match[1]).run(); await db.prepare('DELETE FROM products WHERE id = ?').bind(match[1]).run(); }
    else {
      const item = { id: match[1], ...validate(await body(request)) };
      await detailsTable(db);
      await db.prepare('UPDATE products SET name = ?, description = ?, price_cents = ?, available = ? WHERE id = ?')
        .bind(item.name, item.description, item.priceCents, Number(item.available), match[1]).run();
      await saveDetails(db, item);
    }
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async scheduled(_controller, env) {
    try { await scanSupplier(env); }
    catch (error) { console.error('Daily supplier scan:', error.message); }
  },
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/')) return hardened(await api(request, env, path));
      return hardened(await env.ASSETS.fetch(request));
    } catch (error) {
      const invalid = ['Invalid JSON.', 'Request too large.', 'Enter a name and a valid price.', 'Enter a product name first.', 'Choose whether lockdown is on or off.', 'SKU or supplier is too long.', 'Enter a valid unit cost.', 'Enter a valid shipping cost.', 'Enter a valid stock quantity.', 'Enter a unit cost and target margin from 5% to 70%.', 'Send between 1 and 8 messages.', 'Each message must contain up to 1,000 characters.', 'The last message must be yours.'].includes(error.message);
      if (!invalid) console.error('Request failed:', error.message);
      return hardened(json({ error: invalid ? error.message : 'Server error.' }, invalid ? 400 : 500));
    }
  }
};
