const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const aria = require('./aria');

const publicDir = path.resolve(__dirname, '../frontend');
const dataFile = path.resolve(process.env.DATA_FILE || path.join(__dirname, '../data/products.json'));
const password = process.env.ADMIN_PASSWORD;
const sessions = new Map();
const attempts = new Map();
const ariaUsage = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function products() {
  try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function save(items) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temporary = dataFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, dataFile);
}
function token(req) {
  const id = /(?:^|;\s*)wn_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (!id) return null;
  if ((sessions.get(id) || 0) < Date.now()) { sessions.delete(id); return null; }
  return id;
}
function originAllowed(req) {
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch { return false; }
}
async function readBody(req) {
  let value = '';
  for await (const chunk of req) { value += chunk; if (value.length > 10000) throw new Error('Request too large.'); }
  try { return JSON.parse(value); } catch { throw new Error('Invalid JSON.'); }
}
function validate(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  const price = String(input?.price);
  if (!name || name.length > 100 || description.length > 500 || !/^\d+(\.\d{1,2})?$/.test(price) || Number(price) < 0.01 || Number(price) > 100000) throw new Error('Enter a name and a valid price.');
  return { name, description, priceCents: Math.round(Number(price) * 100), available: input.available === true };
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET' && pathname === '/api/products') return send(res, 200, products().filter(item => item.available));
      if (req.method === 'GET' && pathname === '/api/admin/session') return send(res, 200, { authenticated: !!token(req), configured: !!password, ariaConfigured: !!process.env.OPENAI_API_KEY });
      if (req.method !== 'GET' && !originAllowed(req)) return send(res, 403, { error: 'Invalid request origin.' });
      if (req.method === 'POST' && pathname === '/api/admin/login') {
        if (!password) return send(res, 503, { error: 'Owner login is not configured.' });
        const ip = req.socket.remoteAddress;
        const prior = attempts.get(ip) || { count: 0, until: 0 };
        if (prior.count >= 5 && prior.until > Date.now()) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
        const input = await readBody(req);
        const a = crypto.createHash('sha256').update(typeof input?.password === 'string' ? input.password : '').digest();
        const b = crypto.createHash('sha256').update(password).digest();
        if (!crypto.timingSafeEqual(a, b)) {
          attempts.set(ip, { count: prior.until > Date.now() ? prior.count + 1 : 1, until: Date.now() + 900000 });
          return send(res, 401, { error: 'Incorrect password.' });
        }
        attempts.delete(ip);
        const id = crypto.randomBytes(32).toString('hex');
        sessions.set(id, Date.now() + 43200000);
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return send(res, 200, { authenticated: true }, { 'Set-Cookie': 'wn_session=' + id + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' + secure });
      }
      if (req.method === 'POST' && pathname === '/api/admin/logout') {
        const id = token(req); if (id) sessions.delete(id);
        return send(res, 200, { authenticated: false }, { 'Set-Cookie': 'wn_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (pathname.startsWith('/api/admin/') && !token(req)) return send(res, 401, { error: 'Sign in to manage products.' });
      if (req.method === 'POST' && pathname === '/api/admin/aria') {
        if (!process.env.OPENAI_API_KEY) return send(res, 503, { error: 'Aria needs an API key before she can reply.' });
        const id = token(req);
        const usage = ariaUsage.get(id) || { count: 0, until: 0 };
        if (usage.count >= 20 && usage.until > Date.now()) return send(res, 429, { error: 'Aria has reached the hourly limit. Please try later.' });
        const input = await readBody(req);
        const messages = aria.validateMessages(input?.messages);
        ariaUsage.set(id, { count: usage.until > Date.now() ? usage.count + 1 : 1, until: Date.now() + 3600000 });
        try { return send(res, 200, { reply: await aria.reply({ messages, catalog: products(), key: process.env.OPENAI_API_KEY }) }); }
        catch (error) { console.error('Aria request:', error.message); return send(res, 502, { error: 'Aria could not reply right now. Please try again.' }); }
      }
      if (req.method === 'GET' && pathname === '/api/admin/products') return send(res, 200, products());
      if (req.method === 'POST' && pathname === '/api/admin/products') {
        const item = { id: crypto.randomUUID(), ...validate(await readBody(req)) };
        const items = products(); items.push(item); save(items); return send(res, 201, item);
      }
      const match = /^\/api\/admin\/products\/([a-f0-9-]{36})$/.exec(pathname);
      if (match && (req.method === 'PUT' || req.method === 'DELETE')) {
        const items = products(); const index = items.findIndex(item => item.id === match[1]);
        if (index < 0) return send(res, 404, { error: 'Product not found.' });
        if (req.method === 'DELETE') items.splice(index, 1);
        else items[index] = { id: match[1], ...validate(await readBody(req)) };
        save(items); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return send(res, 400, { error: 'Invalid path.' }); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) return send(res, 400, { error: 'Invalid path.' });
    const file = path.resolve(publicDir, '.' + (decoded === '/' ? '/index.html' : decoded));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 400, { error: 'Invalid path.' });
    fs.readFile(file, (error, content) => {
      if (error) return send(res, error.code === 'ENOENT' ? 404 : 500, { error: 'File unavailable.' });
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'" });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  } catch (error) {
    const invalid = ['Invalid JSON.', 'Request too large.', 'Enter a name and a valid price.', 'Send between 1 and 8 messages.', 'Each message must contain up to 1,000 characters.', 'The last message must be yours.'].includes(error.message);
    if (!invalid) console.error(error);
    send(res, invalid ? 400 : 500, { error: invalid ? error.message : 'Server error.' });
  }
});
if (require.main === module) server.listen(Number(process.env.PORT || 5000), () => console.log('Wheelie Neat server ready'));
module.exports = server;
