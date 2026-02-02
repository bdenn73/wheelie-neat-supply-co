const http = require('http');
const fs = require('fs');
const path = require('path');

// Simple product data. Replace with real data as needed.
const products = [
  // Sample products for the Wheelie Neat Supply Co. store. Feel free to update or extend.
  { id: 1, name: 'Wheelie Board', price: 49.99 },
  { id: 2, name: 'Neat Supply Toolkit', price: 29.99 },
  { id: 3, name: 'Wheelie Parts Kit', price: 19.99 },
  { id: 4, name: 'All‑In‑One Wheelie Bundle', price: 79.99 },
];

// Mime types for serving static files
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Create HTTP server
const server = http.createServer((req, res) => {
  // Serve API endpoint
  if (req.url.startsWith('/api/products')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(products));
    return;
  }

  // Determine the file to serve; default to index.html
  const publicDir = path.join(__dirname, '../frontend');
  let filePath = path.join(
    publicDir,
    req.url === '/' ? 'index.html' : req.url
  );

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        // Fallback to index.html for client-side routing
        fs.readFile(path.join(publicDir, 'index.html'), (err, fallback) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(fallback, 'utf-8');
        });
      } else {
        res.writeHead(500);
        res.end('Sorry, error: ' + error.code + '\n');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// Define the port; default to 5000
const PORT = process.env.PORT || 5000;

// Start the server
server.listen(PORT, () =>
  console.log('Wheelie Neat Supply Co. server running on port ' + PORT)
);
