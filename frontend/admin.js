const loginPanel = document.getElementById('login-panel');
const manager = document.getElementById('manager');
const notice = document.getElementById('notice');
const inventory = document.getElementById('inventory');
const form = document.getElementById('product-form');
const cancel = document.getElementById('cancel');
let editing = null;
let items = [];
let lockdown = false;
let sandboxCheckout = false;
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed.');
  return value;
}
function message(value) { notice.textContent = value; }
function reset() { editing = null; form.reset(); cancel.hidden = true; document.getElementById('form-title').textContent = 'Add a product'; }
function showManager(authenticated) { loginPanel.hidden = authenticated; manager.hidden = !authenticated; document.getElementById('logout').hidden = !authenticated; }
function action(label, callback, kind) { const button = document.createElement('button'); button.type = 'button'; button.className = kind || 'secondary'; button.textContent = label; button.addEventListener('click', callback); return button; }
function render() {
  inventory.replaceChildren();
  if (!items.length) { const p = document.createElement('p'); p.textContent = 'No products yet. Add your first product above.'; inventory.append(p); return; }
  items.forEach(item => {
    const row = document.createElement('div'); row.className = 'inventory-row';
    const detail = document.createElement('div');
    const heading = document.createElement('h3'); heading.textContent = item.name;
    const status = document.createElement('p'); status.textContent = `${(item.priceCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} · ${item.available ? 'Public' : 'Hidden'} · ${item.stockQty === null ? 'Stock not tracked' : `${item.stockQty} on hand`}${item.supplier ? ` · Supplier: ${item.supplier}` : ''}`;
    detail.append(heading, status);
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.append(action('Edit', () => { editing = item.id; form.elements.namedItem('name').value = item.name; form.elements.namedItem('description').value = item.description; form.elements.namedItem('price').value = (item.priceCents / 100).toFixed(2); form.elements.namedItem('available').checked = item.available; for (const key of ['sku', 'supplier']) form.elements.namedItem(key).value = item[key] || ''; for (const [key, cents] of [['unitCost', item.unitCostCents], ['shippingCost', item.shippingCostCents]]) form.elements.namedItem(key).value = cents === null ? '' : (cents / 100).toFixed(2); form.elements.namedItem('stockQty').value = item.stockQty ?? ''; cancel.hidden = false; document.getElementById('form-title').textContent = 'Edit product'; form.scrollIntoView({ behavior: 'smooth' }); }), action('Delete', async () => {
      if (!confirm(`Delete ${item.name}?`)) return;
      try { await api(`/api/admin/products/${item.id}`, { method: 'DELETE' }); await refresh(); reset(); message('Product deleted.'); } catch (error) { message(error.message); }
    }, 'danger'));
    if (sandboxCheckout && item.available && item.stockQty !== 0) actions.append(action('Test checkout', async () => {
      try { const result = await api('/api/checkout/sandbox/create', { method: 'POST', body: JSON.stringify({ productId: item.id }) }); window.location.assign(result.approval); }
      catch (error) { message(error.message); }
    }));
    row.append(detail, actions); inventory.append(row);
  });
}
async function refresh() { items = await api('/api/admin/products'); render(); }
async function refreshCheckout() {
  const checkout = await api('/api/checkout/status');
  sandboxCheckout = checkout.sandbox;
  document.getElementById('checkout-connection').textContent = sandboxCheckout ? 'PayPal sandbox is connected. Published products have a Test checkout action; no real money moves.' : 'PayPal sandbox is waiting for PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_MODE=sandbox in Cloudflare.';
  const orders = await api('/api/admin/orders');
  const list = document.getElementById('orders'); list.replaceChildren();
  orders.slice(0, 10).forEach(order => {
    const row = document.createElement('p');
    row.textContent = `${order.product_name || 'Deleted product'} · $${(order.price_cents / 100).toFixed(2)} · ${order.status} · ${new Date(order.created_at).toLocaleString()}`;
    list.append(row);
  });
}
async function refreshSecurity() {
  const state = await api('/api/admin/security');
  lockdown = state.lockdown;
  document.getElementById('security-status').textContent = `${lockdown ? 'Lockdown is ON. Public listings are hidden.' : 'Lockdown is off.'} ${state.failedLogins7d} failed owner sign-in attempt${state.failedLogins7d === 1 ? '' : 's'} in the last 7 days.`;
  const button = document.getElementById('lockdown');
  button.textContent = lockdown ? 'Restore public catalog' : 'Turn on lockdown';
  button.className = lockdown ? 'secondary' : 'danger';
}
document.getElementById('supplier-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('supplier-search');
  const results = document.getElementById('supplier-results');
  button.disabled = true; results.textContent = 'Searching supplier catalog…';
  try {
    const data = await api(`/api/admin/supplier/search?q=${encodeURIComponent(document.getElementById('supplier-query').value.trim())}`);
    results.replaceChildren();
    if (!data.products.length) { results.textContent = 'No matching products found.'; return; }
    data.products.forEach(product => {
      const row = document.createElement('div'); row.className = 'inventory-row';
      const details = document.createElement('div');
      const heading = document.createElement('h3'); heading.textContent = product.name;
      const summary = document.createElement('p'); summary.textContent = `CJ ID: ${product.id} · SKU: ${product.sku || 'Unknown'} · Supplier price: ${product.supplierPrice || 'Check CJ'}`;
      details.append(heading, summary);
      row.append(details, action('Use as draft', () => {
        reset(); form.elements.namedItem('name').value = product.name.slice(0, 100);
        form.elements.namedItem('sku').value = product.sku;
        form.elements.namedItem('supplier').value = `CJdropshipping ${product.id}`.slice(0, 150);
        if (/^\d+(\.\d{1,2})?$/.test(product.supplierPrice)) form.elements.namedItem('unitCost').value = product.supplierPrice;
        message('Supplier candidate copied into a hidden draft. Check the exact variant, cost, shipping, and stock before asking Aria to draft.');
        form.scrollIntoView({ behavior: 'smooth' });
      }));
      results.append(row);
    });
  } catch (error) { results.textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById('lockdown').addEventListener('click', async () => {
  try { await api('/api/admin/security/lockdown', { method: 'POST', body: JSON.stringify({ lockdown: !lockdown }) }); await refreshSecurity(); message(lockdown ? 'Emergency lockdown is on. Public listings are hidden.' : 'Public catalog restored.'); }
  catch (error) { message(error.message); }
});
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('password').value }) }); document.getElementById('password').value = ''; showManager(true); await Promise.all([refreshCheckout(), refreshSecurity()]); await refresh(); message('Signed in.'); }
  catch (error) { message(error.message); }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = { name: form.elements.namedItem('name').value, description: form.elements.namedItem('description').value, price: form.elements.namedItem('price').value, available: form.elements.namedItem('available').checked, sku: form.elements.namedItem('sku').value, supplier: form.elements.namedItem('supplier').value, unitCost: form.elements.namedItem('unitCost').value, shippingCost: form.elements.namedItem('shippingCost').value, stockQty: form.elements.namedItem('stockQty').value };
  try { await api(editing ? `/api/admin/products/${editing}` : '/api/admin/products', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(data) }); reset(); await refresh(); message('Product saved.'); }
  catch (error) { message(error.message); }
});
cancel.addEventListener('click', reset);
document.getElementById('draft').addEventListener('click', async () => {
  const field = key => form.elements.namedItem(key).value;
  const button = document.getElementById('draft');
  if (!field('name').trim()) { message('Enter a product name first.'); return; }
  button.disabled = true; message('Aria is drafting. Nothing will be saved or published until you review it.');
  try {
    const result = await api('/api/admin/aria/draft', { method: 'POST', body: JSON.stringify({ name: field('name'), sku: field('sku'), notes: field('description'), unitCostCents: field('unitCost') === '' ? null : Math.round(Number(field('unitCost')) * 100), shippingCostCents: field('shippingCost') === '' ? null : Math.round(Number(field('shippingCost')) * 100), targetMargin: Number(field('targetMargin')) }) });
    form.elements.namedItem('description').value = result.description;
    if (result.priceCents !== null) form.elements.namedItem('price').value = (result.priceCents / 100).toFixed(2);
    message(`Draft ready. ${result.pricingNote} Check the description and price, then save when ready.`);
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
document.getElementById('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); showManager(false); reset(); message('Signed out.'); });
api('/api/admin/session').then(async state => { showManager(state.authenticated); if (!state.configured) message('Owner login needs to be configured before products can be managed.'); if (state.authenticated) { await Promise.all([refreshCheckout(), refreshSecurity()]); await refresh(); } }).catch(error => message(error.message));
