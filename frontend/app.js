// Register the service worker for offline support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(err => {
    console.error('Service worker registration failed:', err);
  });
}

// Fetch products from the backend and display them
function loadProducts() {
  fetch('/api/products')
    .then(res => res.json())
    .then(data => {
      const list = document.getElementById('product-list');
      list.innerHTML = '';
      data.forEach(p => {
        const div = document.createElement('div');
        div.textContent = p.name + ' - $' + p.price.toFixed(2);
        list.appendChild(div);
      });
    })
    .catch(err => {
      document.getElementById('product-list').textContent = 'Failed to load products.';
      console.error(err);
    });
}

// Load products when the page finishes loading
window.addEventListener('load', loadProducts);
