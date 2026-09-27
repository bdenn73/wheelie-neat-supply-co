// Cloudflare Workers version of the catalog API. Static files live in /frontend.
import { validateMessages, reply } from './aria.js';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
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
  return { name, description, priceCents: Math.round(Number(price) * 100), available: input.available === true };
}
const mapProduct = row => ({ id: row.id, name: row.name, description: row.description, priceCents: row.price_cents, available: row.available === 1 });
async function products(db, publicOnly = false) {
  const query = 'SELECT id, name, description, price_cents, available FROM products' + (publicOnly ? ' WHERE available = 1' : '') + ' ORDER BY rowid DESC';
  return (await db.prepare(query).all()).results.map(mapProduct);
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
  if (request.method === 'GET' && path === '/api/products') return json(await products(db, true));
  if (request.method === 'GET' && path === '/api/admin/session') return json({
    authenticated: !!(await authenticated(db, request)), configured: !!env.ADMIN_PASSWORD, ariaConfigured: !!env.OPENAI_API_KEY
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
  const id = await authenticated(db, request);
  if (!id) return json({ error: 'Sign in to manage products.' }, 401);
  if (request.method === 'POST' && path === '/api/admin/aria') {
    if (!env.OPENAI_API_KEY) return json({ error: 'Aria needs an API key before she can reply.' }, 503);
    const now = Date.now();
    const usage = await db.prepare('SELECT count, expires_at FROM aria_usage WHERE session_id = ?').bind(id).first();
    if (usage?.count >= 20 && usage.expires_at > now) return json({ error: 'Aria has reached the hourly limit. Please try later.' }, 429);
    const input = await body(request);
    const messages = validateMessages(input?.messages);
    await db.prepare('INSERT INTO aria_usage (session_id, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at')
      .bind(id, usage?.expires_at > now ? usage.count + 1 : 1, usage?.expires_at > now ? usage.expires_at : now + 3600000).run();
    try { return json({ reply: await reply({ messages, catalog: await products(db), key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }) }); }
    catch (error) { console.error('Aria request:', error.message); return json({ error: 'Aria could not reply right now. Please try again.' }, 502); }
  }
  if (request.method === 'GET' && path === '/api/admin/products') return json(await products(db));
  if (request.method === 'POST' && path === '/api/admin/products') {
    const item = { id: crypto.randomUUID(), ...validate(await body(request)) };
    await db.prepare('INSERT INTO products (id, name, description, price_cents, available) VALUES (?, ?, ?, ?, ?)')
      .bind(item.id, item.name, item.description, item.priceCents, Number(item.available)).run();
    return json(item, 201);
  }
  const match = /^\/api\/admin\/products\/([a-f0-9-]{36})$/.exec(path);
  if (match && (request.method === 'PUT' || request.method === 'DELETE')) {
    const existing = await db.prepare('SELECT id FROM products WHERE id = ?').bind(match[1]).first();
    if (!existing) return json({ error: 'Product not found.' }, 404);
    if (request.method === 'DELETE') await db.prepare('DELETE FROM products WHERE id = ?').bind(match[1]).run();
    else {
      const item = validate(await body(request));
      await db.prepare('UPDATE products SET name = ?, description = ?, price_cents = ?, available = ? WHERE id = ?')
        .bind(item.name, item.description, item.priceCents, Number(item.available), match[1]).run();
    }
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/')) return await api(request, env, path);
      return env.ASSETS.fetch(request);
    } catch (error) {
      const invalid = ['Invalid JSON.', 'Request too large.', 'Enter a name and a valid price.', 'Send between 1 and 8 messages.', 'Each message must contain up to 1,000 characters.', 'The last message must be yours.'].includes(error.message);
      if (!invalid) console.error('Request failed:', error.message);
      return json({ error: invalid ? error.message : 'Server error.' }, invalid ? 400 : 500);
    }
  }
};
