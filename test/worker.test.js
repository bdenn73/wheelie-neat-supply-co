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
  const env = { DB: db, ADMIN_PASSWORD: 'unique-test-password-123', ASSETS: { fetch: async () => new Response('asset') } };
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
  assert.equal((await request('/api/admin/session', 'GET', null, cookie)).status, 200);
  assert.equal((await request('/api/admin/products', 'POST', { name: 'X', price: '9.99' }, cookie, 'https://attacker.example')).status, 403);
  const created = await request('/api/admin/products', 'POST', { name: 'First item', description: 'Test', price: '12.50', available: false }, cookie);
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.deepEqual(await (await request('/api/products')).json(), []);
  const saved = await request('/api/admin/products/' + item.id, 'PUT', { name: item.name, description: 'Test', price: '12.50', available: true }, cookie);
  assert.equal(saved.status, 200);
  assert.equal((await (await request('/api/products')).json())[0].priceCents, 1250);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 1);
  await request('/api/admin/logout', 'POST', null, cookie);
  assert.equal((await request('/api/admin/products', 'GET', null, cookie)).status, 401);
  sqlite.close();
});
