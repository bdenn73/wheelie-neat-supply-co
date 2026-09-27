# Wheelie Neat Supply Co.

A small storefront and owner product manager. It is separate from the existing B12 storefront. It does not collect orders or payments, and Aria AI is not connected.

## Run locally

Use Node.js 20 or newer. Set an owner password of at least 12 unique characters, then start the server:

```sh
ADMIN_PASSWORD='your-own-long-unique-password' npm start
```

Open http://localhost:5000/ for the catalog and http://localhost:5000/admin.html to add products. Products start hidden until you mark them public. The server stores products in `data/products.json` by default. Set `DATA_FILE` to an absolute path on persistent storage for deployment; ephemeral hosting storage will lose the catalog on redeploy or restart. Set `PORT` if required by your host. Keep `ADMIN_PASSWORD` in host secrets, never in source control.

Run `npm test` for API and access checks. Serve behind HTTPS in production. Owner sessions are in memory and end on server restart. This release is a catalog management foundation; checkout, payment processing, B12 synchronization, and Aria need separate integration work and credentials.

## Aria owner assistant

Aria lives at `/aria.html` and uses the same owner password as product management. Set `OPENAI_API_KEY` as a server-side secret to enable replies. `OPENAI_MODEL` defaults to `gpt-5.4-mini` and can be changed to a model available to your API project. The key is never sent to the browser. The server calls the OpenAI Responses API with `store: false`; it sends the owner's recent conversation and up to 50 catalog products to provide context. Chat history stays in the open browser tab. Aria has no tools to modify products, contact customers, read orders, access B12, or process payments. The owner is limited to 20 requests per hour per sign-in session. Set a budget and usage limits in the OpenAI Platform before using a production key.
