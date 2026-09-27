# Wheelie Neat Supply Co.

Cloudflare Worker storefront and owner product manager: https://wheelie-neat-supply-co.n6n5tmwjgk.workers.dev/ . The separate B12 site is not synced. The public catalog starts empty until the owner enters and publishes real products.

## Owner workflow

Open `/admin` and sign in with the existing `ADMIN_PASSWORD` secret. Enter a product name, SKU, supplier, unit cost, estimated shipping cost per unit, and stock on hand. The supplier, costs, and stock stay in the owner API; the public API includes only name, description, price, and availability. Enter facts in the description box, then select **Ask Aria to draft**. Aria proposes a short description and a price based on `(unit cost + shipping cost + $0.49) / (1 - target margin - 0.0349)`, rounded up to a cent. This estimates the domestic PayPal Checkout fee of 3.49% plus $0.49 per transaction; actual fees vary. Returns, taxes, and overhead are excluded. Review the draft, actual supplier availability, and price before saving. New products remain hidden until **Show in public catalog** is checked. A published product with tracked stock at zero is hidden automatically.

Aria chat is at `/aria.html`. The Cloudflare Worker uses the Workers AI binding with the `@cf/meta/llama-3.1-8b-instruct` model, subject to Cloudflare's free daily allowance. An optional `OPENAI_API_KEY` secret is a fallback when the AI binding is absent; it is not needed for the Cloudflare deployment. The 20 calls per hour per owner session limit still applies. The assistant only sees the owner catalog records; it cannot search the live market, purchase stock, contact suppliers, fulfill orders, edit products by chat, or handle payments. The owner draft action fills the form without saving or publishing it.

The owner security panel shows failed login attempts over the last seven days and can switch on an emergency catalog lockdown. Lockdown hides all public product listings while preserving owner access to investigate and restore service. Login attempts are recorded with a one-way digest of the source IP, not the raw IP. This is a basic control, not active detection across Cloudflare, GitHub, payment, and supplier accounts.

The existing D1 database and `ADMIN_PASSWORD` are required. The Worker creates its `product_details` table on the first authenticated catalog request. The existing `products` table and owner sessions remain in place. `wrangler.jsonc` contains the AI and D1 bindings and is deployed via GitHub integration. Keep secrets out of the repository.

## Development

`npm test` verifies owner access, private product details, draft calculation, and public catalog separation. `worker/` is the deployed Cloudflare implementation. `backend/` is an older local Node server with fewer features and is not the production target. The storefront does not process payments or orders. B12 and PayPal are not connected.

## Supplier and checkout connections

CJdropshipping is the first supplier candidate for household and utility products. The owner-only search reads CJ's catalog from the Worker using `CJ_API_KEY` as a Cloudflare production secret. The API key and access token are never returned to the browser. Search is capped at 20 requests per owner session per hour. Using a result copies a hidden product draft; supplier price, variant, shipping, and stock require verification before publishing. Aria can then draft the listing and suggest a price. No CJ order is placed automatically.

PayPal checkout is prepared in **sandbox only**. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` as Worker secrets and `PAYPAL_MODE=sandbox` as a runtime variable, using credentials from a PayPal sandbox app. A signed-in owner can select **Test checkout** on a hidden or published product, approve the simulated payment at PayPal, and verify the capture on `/checkout.html`. The Worker calculates the amount from the database, validates the returned approval host, verifies the PayPal capture amount/currency/order reference, and stores a test order in D1. No real money moves. Public buyers do not see checkout buttons. Live checkout and automated fulfillment require shipping/returns handling, supplier variant mapping, payment webhooks, fraud review, stock reservation, and owner approval of financial limits before activation. Do not set live PayPal credentials as sandbox secrets.

The existing GitHub-to-Cloudflare deployment can update code and bindings. It does not expose Cloudflare dashboard settings or secrets to this workspace. Add all credentials privately in Cloudflare; do not put them in GitHub files or chat.
