# Wheelie Neat Supply Co.

A small storefront, owner product manager, and owner-only Aria assistant. This is separate from the existing B12 storefront. It does not collect orders or payments. Aria requires an API key and funded API balance for live replies.

## Free-tier deployment preparation

The `worker/` implementation runs the product API and owner-only Aria assistant on Cloudflare Workers with a D1 database, so products and sessions survive Worker restarts. The static website is served from `frontend/`. Workers and D1 have free tiers with limits; this does not make OpenAI API replies free. This project is **not deployed** until the owner creates a Cloudflare account and deploys it. The catalog starts empty; no sample products are offered for sale.

Once a Cloudflare account is ready, from this directory:

1. Install Wrangler: `npm install --save-dev wrangler` and authenticate with `npx wrangler login`.
2. Create a D1 database: `npx wrangler d1 create wheelie-neat-catalog`. Copy its `database_id` into `wrangler.jsonc`.
3. Create the tables: `npx wrangler d1 execute wheelie-neat-catalog --remote --file=./worker/schema.sql`.
4. Deploy: `npx wrangler deploy`. Then add an owner password with `npx wrangler secret put ADMIN_PASSWORD`. Choose a unique password at least 12 characters long. Do not store it in GitHub.
5. When you decide to fund AI usage, add `OPENAI_API_KEY` with `npx wrangler secret put OPENAI_API_KEY`. The key belongs only in the Worker secret, never in browser code, chat, or GitHub.
6. Open the deployed `*.workers.dev` URL, visit `/admin.html`, sign in, add real products, and publish each one when ready. Add the URL to the iPhone Home Screen to use it like an app.

This deployment does not copy products from B12, change the B12 site, connect PayPal, or create a native App Store app. The old Node server remains available for local development. Run `npm test` before deploying.

## Run locally

Use Node.js 20 or newer. Set an owner password of at least 12 unique characters, then start the server:

```sh
ADMIN_PASSWORD='your-own-long-unique-password' npm start
```

Open http://localhost:5000/ for the catalog and http://localhost:5000/admin.html to add products. Products start hidden until you mark them public. The server stores products in `data/products.json` by default. Set `DATA_FILE` to an absolute path on persistent storage for deployment; ephemeral hosting storage will lose the catalog on redeploy or restart. Set `PORT` if required by your host. Keep `ADMIN_PASSWORD` in host secrets, never in source control.

Run `npm test` for API and access checks. Serve behind HTTPS in production. Owner sessions are in memory and end on server restart. Checkout, payment processing, and B12 synchronization still need separate integration work and credentials.

## Aria owner assistant

Aria lives at `/aria.html` and uses the same owner password as product management. Set `OPENAI_API_KEY` as a server-side secret to enable replies. `OPENAI_MODEL` defaults to `gpt-5.4-mini` and can be changed to a model available to your API project. The key is never sent to the browser. The server calls the OpenAI Responses API with `store: false`; it sends the owner's recent conversation and up to 50 catalog products to provide context. Chat history stays in the open browser tab. Aria has no tools to modify products, contact customers, read orders, access B12, or process payments. The owner is limited to 20 requests per hour per sign-in session. Set a budget and usage limits in the OpenAI Platform before using a production key.
