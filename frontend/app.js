document.getElementById('year').textContent = new Date().getFullYear();
const list = document.getElementById('product-list');
const count = document.getElementById('count');
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
fetch('/api/products').then(async response => {
  if (!response.ok) throw new Error('Catalog unavailable');
  const products = await response.json();
  const lockdown = response.headers.get('X-Catalog-Lockdown') === 'on';
  count.textContent = `${products.length} ${products.length === 1 ? 'item' : 'items'}`;
  list.replaceChildren();
  if (!products.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const heading = document.createElement('h3'); heading.textContent = lockdown ? 'Catalog temporarily unavailable.' : 'Products are on their way.';
    const message = document.createElement('p'); message.textContent = lockdown ? 'Please check back later.' : 'Check back soon for the first collection.';
    empty.append(heading, message); list.append(empty); return;
  }
  products.forEach(product => {
    const card = document.createElement('article'); card.className = 'product-card';
    const badge = document.createElement('span'); badge.className = 'eyebrow'; badge.textContent = 'AVAILABLE';
    const heading = document.createElement('h3'); heading.textContent = product.name;
    const description = document.createElement('p'); description.textContent = product.description;
    const price = document.createElement('strong'); price.textContent = money(product.priceCents);
    card.append(badge, heading, description, price); list.append(card);
  });
}).catch(() => { list.textContent = 'The catalog could not load. Please try again later.'; count.textContent = ''; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
