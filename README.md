# Wheelie Neat Supply Co.

Cloudflare Worker storefront and owner product manager: https://wheelie-neat-supply-co.n6n5tmwjgk.workers.dev/ . The separate B12 site is not synced. The public catalog starts empty until the owner enters and publishes real products.

## Owner workflow

Open `/admin` and sign in with the existing `ADMIN_PASSWORD` secret. Enter a product name, SKU, supplier, unit cost, estimated shipping cost per unit, and stock on hand. The supplier, costs, and stock stay in the owner API; the public API includes only name, description, price, and availability. Enter facts in the description box, then select **Ask Aria to draft**. Aria proposes a short description and a price based on `(unit cost + shipping cost) / (1 - target gross margin)`, rounded up to a cent. This excludes selling fees, returns, taxes, and overhead. Review the draft, actual supplier availability, and price before saving. New products remain hidden until **Show in public catalog** is checked. A published product with tracked stock at zero is hidden automatically.

Aria chat is at `/aria.html`. The Cloudflare Worker uses the Workers AI binding with the `@cf/meta/llama-3.1-8b-instruct` model, subject to Cloudflare's free daily allowance. An optional `OPENAI_API_KEY` secret is a fallback when the AI binding is absent; it is not needed for the Cloudflare deployment. The 20 calls per hour per owner session limit still applies. The assistant only sees the owner catalog records; it cannot search the live market, purchase stock, contact suppliers, fulfill orders, edit products by chat, or handle payments. The owner draft action fills the form without saving or publishing it.

The owner security panel shows failed login attempts over the last seven days and can switch on an emergency catalog lockdown. Lockdown hides all public product listings while preserving owner access to investigate and restore service. Login attempts are recorded with a one-way digest of the source IP, not the raw IP. This is a basic control, not active detection across Cloudflare, GitHub, payment, and supplier accounts.

The existing D1 database and `ADMIN_PASSWORD` are required. The Worker creates its `product_details` table on the first authenticated catalog request. The existing `products` table and owner sessions remain in place. `wrangler.jsonc` contains the AI and D1 bindings and is deployed via GitHub integration. Keep secrets out of the repository.

## Development

`npm test` verifies owner access, private product details, draft calculation, and public catalog separation. `worker/` is the deployed Cloudflare implementation. `backend/` is an older local Node server with fewer features and is not the production target. The storefront does not process payments or orders. B12 and PayPal are not connected.
