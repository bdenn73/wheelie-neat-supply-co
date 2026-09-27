const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('free-tier Worker keeps catalog and owner sessions in D1', async () => {
  const { default: worker } = await import('../worker/index.js');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(__dirname, '../worker/schema.sql'), 'utf8'));
  const db = {
    prepare(sql) {
      let values = [];
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) || null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return statement.run(...values); }
      };
    }
  };
  const env = { DB: db, ADMIN_PASSWORD: 'unique-test-password-123', AI: { run: async (_model, input) => ({ response: input.messages.at(-1).content.includes('Draft a factual') ? 'A concise product description.' : 'I can help review your catalog.' }) }, ASSETS: { fetch: async () => new Response('asset') } };
  const origin = 'https://wheelie-neat.example';
  const request = (path, method = 'GET', data, cookie, requestOrigin = origin) => worker.fetch(new Request(origin + path, {
    method, headers: { Origin: requestOrigin, ...(cookie ? { Cookie: cookie } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {})
  }), env);
  assert.deepEqual(await (await request('/api/products')).json(), []);
  assert.equal((await request('/api/admin/products', 'POST', { name: 'Private', price: '9.99' })).status, 401);
  const login = await request('/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/admin/login', 'POST', { password: 'incorrect' })).status, 401);
  assert.equal((await (await request('/api/admin/security', 'GET', null, cookie)).json()).failedLogins7d, 1);
  assert.equal((await request('/api/admin/session', 'GET', null, cookie)).status, 200);
  assert.equal((await request('/api/admin/products', 'POST', { name: 'X', price: '9.99' }, cookie, 'https://attacker.example')).status, 403);
  const draft = await request('/api/admin/aria/draft', 'POST', { name: 'First item', notes: 'Useful item', unitCostCents: 800, shippingCostCents: 200, targetMargin: 30 }, cookie);
  assert.equal(draft.status, 200);
  assert.deepEqual((await draft.json()).priceCents, 1578);
  assert.deepEqual(await (await request('/api/admin/products', 'GET', null, cookie)).json(), []);
  assert.equal((await request('/api/admin/aria', 'POST', { messages: [{ role: 'user', content: 'What is in the catalog?' }] }, cookie)).status, 200);
  const created = await request('/api/admin/products', 'POST', { name: 'First item', description: 'Test', price: '12.50', available: false, sku: 'SKU-1', supplier: 'Private supply', unitCost: '8.00', shippingCost: '2.00', stockQty: 4 }, cookie);
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.deepEqual(await (await request('/api/products')).json(), []);
  assert.equal((await (await request('/api/admin/products', 'GET', null, cookie)).json())[0].supplier, 'Private supply');
  const saved = await request('/api/admin/products/' + item.id, 'PUT', { name: item.name, description: 'Test', price: '12.50', available: true, sku: 'SKU-1', supplier: 'Private supply', unitCost: '8.00', shippingCost: '2.00', stockQty: 4 }, cookie);
  assert.equal(saved.status, 200);
  const publicProduct = (await (await request('/api/products')).json())[0];
  assert.equal(publicProduct.priceCents, 1250);
  assert.equal('supplier' in publicProduct, false);
  assert.equal('unitCostCents' in publicProduct, false);
  assert.equal((await request('/api/admin/security/lockdown', 'POST', { lockdown: true })).status, 401);
  assert.equal((await request('/api/admin/security/lockdown', 'POST', { lockdown: true }, cookie)).status, 200);
  const closed = await request('/api/products');
  assert.equal(closed.headers.get('X-Catalog-Lockdown'), 'on');
  assert.deepEqual(await closed.json(), []);
  assert.equal((await (await request('/api/admin/security', 'GET', null, cookie)).json()).lockdown, true);
  await request('/api/admin/security/lockdown', 'POST', { lockdown: false }, cookie);
  assert.equal((await (await request('/api/products')).json()).length, 1);
  assert.equal((await request('/api/products')).headers.get('X-Frame-Options'), 'DENY');
  await request('/api/admin/products/' + item.id, 'PUT', { name: item.name, description: 'Test', price: '12.50', available: true, stockQty: 0 }, cookie);
  assert.deepEqual(await (await request('/api/products')).json(), []);
  assert.equal((await (await request('/api/admin/products', 'GET', null, cookie)).json())[0].stockQty, 0);
  const originalFetch = global.fetch;
  try {
    env.CJ_API_KEY = 'test-cj-key';
    global.fetch = async (url) => new Response(JSON.stringify(String(url).includes('getAccessToken') ? { result: true, data: { accessToken: 'test-token' } } : { result: true, data: { content: [{ productList: [{ id: 'cj-123', nameEn: 'Storage organizer', sku: 'ORG-1', sellPrice: '8.50' }] }] } }), { status: 200 });
    const supplier = await (await request('/api/admin/supplier/search?q=storage', 'GET', null, cookie)).json();
    assert.equal(supplier.products[0].name, 'Storage organizer');
    assert.equal('apiKey' in supplier, false);
    await worker.scheduled({}, env);
    const scout = await (await request('/api/admin/scout', 'GET', null, cookie)).json();
    assert.equal(scout.candidates[0].name, 'Storage organizer');
    assert.equal((await request('/api/admin/scout')).status, 401);
    env.PAYPAL_MODE = 'sandbox'; env.PAYPAL_CLIENT_ID = 'test-client'; env.PAYPAL_CLIENT_SECRET = 'test-secret';
    await request('/api/admin/products/' + item.id, 'PUT', { name: item.name, price: '12.50', available: false, stockQty: 2 }, cookie);
    let createdPayPalId;
    global.fetch = async (url, options) => {
      if (String(url).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'test-paypal-token' }), { status: 200 });
      if (String(url).endsWith('/v2/checkout/orders')) {
        const payload = JSON.parse(options.body); createdPayPalId = payload.purchase_units[0].custom_id;
        assert.equal(payload.purchase_units[0].amount.value, '12.50');
        return new Response(JSON.stringify({ id: 'PAYPAL-123', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-123' }] }), { status: 201 });
      }
      if (String(url).endsWith('/PAYPAL-123/capture')) return new Response(JSON.stringify({ id: 'PAYPAL-123', status: 'COMPLETED', purchase_units: [{ custom_id: createdPayPalId, payments: { captures: [{ id: 'CAPTURE-123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '12.50' } }] } }] }), { status: 201 });
      throw new Error('Unexpected PayPal request');
    };
    const checkout = await request('/api/checkout/sandbox/create', 'POST', { productId: item.id }, cookie);
    assert.equal(checkout.status, 201);
    assert.match((await checkout.json()).approval, /^https:\/\/www\.sandbox\.paypal\.com\//);
    assert.equal((await request('/api/checkout/sandbox/capture', 'POST', { token: 'PAYPAL-123' })).status, 401);
    const captured = await request('/api/checkout/sandbox/capture', 'POST', { token: 'PAYPAL-123' }, cookie);
    assert.equal((await captured.json()).status, 'completed');
    global.fetch = async url => String(url).endsWith('/v1/oauth2/token')
      ? new Response(JSON.stringify({ access_token: 'test-paypal-token' }), { status: 200 })
      : new Response(JSON.stringify({ name: 'INVALID_REQUEST', details: [{ issue: 'INVALID_PARAMETER_VALUE' }], debug_id: 'a1b2c3d4e5f6' }), { status: 400 });
    const rejected = await request('/api/checkout/sandbox/create', 'POST', { productId: item.id }, cookie);
    assert.equal(rejected.status, 502);
    assert.match((await rejected.json()).error, /HTTP 400: INVALID_REQUEST \/ INVALID_PARAMETER_VALUE \(debug ID a1b2c3d4e5f6\)/);
    global.fetch = async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
    const badCredentials = await request('/api/checkout/sandbox/create', 'POST', { productId: item.id }, cookie);
    assert.equal(badCredentials.status, 502);
    assert.match((await badCredentials.json()).error, /sandbox authentication failed/);
  } finally { global.fetch = originalFetch; }
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 1);
  await request('/api/admin/logout', 'POST', null, cookie);
  assert.equal((await request('/api/admin/products', 'GET', null, cookie)).status, 401);
  sqlite.close();
});
