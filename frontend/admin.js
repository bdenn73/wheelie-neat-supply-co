const loginPanel = document.getElementById('login-panel');
const manager = document.getElementById('manager');
const notice = document.getElementById('notice');
const inventory = document.getElementById('inventory');
const form = document.getElementById('product-form');
const cancel = document.getElementById('cancel');
let editing = null;
let items = [];
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
    const status = document.createElement('p'); status.textContent = `${(item.priceCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} · ${item.available ? 'Public' : 'Hidden'}`;
    detail.append(heading, status);
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.append(action('Edit', () => { editing = item.id; form.elements.namedItem('name').value = item.name; form.elements.namedItem('description').value = item.description; form.elements.namedItem('price').value = (item.priceCents / 100).toFixed(2); form.elements.namedItem('available').checked = item.available; cancel.hidden = false; document.getElementById('form-title').textContent = 'Edit product'; form.scrollIntoView({ behavior: 'smooth' }); }), action('Delete', async () => {
      if (!confirm(`Delete ${item.name}?`)) return;
      try { await api(`/api/admin/products/${item.id}`, { method: 'DELETE' }); await refresh(); reset(); message('Product deleted.'); } catch (error) { message(error.message); }
    }, 'danger'));
    row.append(detail, actions); inventory.append(row);
  });
}
async function refresh() { items = await api('/api/admin/products'); render(); }
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('password').value }) }); document.getElementById('password').value = ''; showManager(true); await refresh(); message('Signed in.'); }
  catch (error) { message(error.message); }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = { name: form.elements.namedItem('name').value, description: form.elements.namedItem('description').value, price: form.elements.namedItem('price').value, available: form.elements.namedItem('available').checked };
  try { await api(editing ? `/api/admin/products/${editing}` : '/api/admin/products', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(data) }); reset(); await refresh(); message('Product saved.'); }
  catch (error) { message(error.message); }
});
cancel.addEventListener('click', reset);
document.getElementById('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); showManager(false); reset(); message('Signed out.'); });
api('/api/admin/session').then(async state => { showManager(state.authenticated); if (!state.configured) message('Owner login needs to be configured before products can be managed.'); if (state.authenticated) await refresh(); }).catch(error => message(error.message));
