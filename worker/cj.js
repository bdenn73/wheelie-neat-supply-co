// Read-only CJdropshipping catalog connector. The API key and access token never reach the browser.
const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
let cached = { key: null, token: null, until: 0 };

async function token(apiKey) {
  if (cached.key === apiKey && cached.until > Date.now()) return cached.token;
  const response = await fetch(`${BASE}/authentication/getAccessToken`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }), signal: AbortSignal.timeout(15000)
  });
  const value = await response.json();
  if (!response.ok || !value.result || !value.data?.accessToken) throw new Error('CJ authentication failed.');
  cached = { key: apiKey, token: value.data.accessToken, until: Date.now() + 12 * 3600000 };
  return cached.token;
}

export async function searchCJ(apiKey, keyword, trending = false) {
  const q = typeof keyword === 'string' ? keyword.trim() : '';
  if (q.length < 2 || q.length > 80) throw new Error('Enter a supplier search of 2 to 80 characters.');
  const accessToken = await token(apiKey);
  const url = `${BASE}/product/listV2?page=1&size=10&keyWord=${encodeURIComponent(q)}&countryCode=US&verifiedWarehouse=1${trending ? '&productFlag=0&startWarehouseInventory=1' : ''}`;
  const response = await fetch(url, { headers: { 'CJ-Access-Token': accessToken }, signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok || !value.result) throw new Error('CJ product search failed.');
  const groups = Array.isArray(value.data?.content) ? value.data.content : [];
  return groups.flatMap(group => Array.isArray(group.productList) ? group.productList : []).slice(0, 10).map(product => ({
    id: String(product.id || '').slice(0, 100), name: String(product.nameEn || '').slice(0, 150),
    sku: String(product.sku || product.spu || '').slice(0, 80),
    supplierPrice: String(product.sellPrice || '').slice(0, 50),
    image: /^https:\/\//.test(product.bigImage || '') ? product.bigImage : null
  }));
}
