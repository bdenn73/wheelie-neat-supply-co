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
  assert.deepEqual((await draft.json()).priceCents, 1429);
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
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 1);
  await request('/api/admin/logout', 'POST', null, cookie);
  assert.equal((await request('/api/admin/products', 'GET', null, cookie)).status, 401);
  sqlite.close();
});
