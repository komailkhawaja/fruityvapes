// paymentProviders.js
//
// This machine currently runs in "no payment required" test mode — /api/order dispenses
// immediately without charging anyone. Before this goes live with real customers, wire in
// a real payment step here.
//
// I can't set this up for you end-to-end because it requires a merchant account and live
// API credentials from a provider (JazzCash and Easypaisa are the standard choices for
// Pakistan). Once you have those, this file is the plug-in point:
//
//   1. Sign up for a JazzCash or Easypaisa merchant/business account.
//   2. They'll give you a merchant ID, password, and integrity salt (JazzCash) or
//      store ID + hash key (Easypaisa). Put these in your .env file, e.g.:
//        JAZZCASH_MERCHANT_ID=...
//        JAZZCASH_PASSWORD=...
//        JAZZCASH_SALT=...
//   3. Implement `createPayment()` below to call their REST API (both providers publish
//      integration guides with a checkout-redirect flow and a webhook/callback URL for
//      confirming payment).
//   4. In server.js, change POST /api/order so it first calls createPayment() and only
//      calls mqttBridge.sendDispenseCommand() once the provider confirms the payment
//      succeeded (via their callback, not just the redirect — callbacks are the source
//      of truth, redirects can be spoofed).
//
// Until that's wired up, treat this machine as free-vend / test mode only.

async function createPayment({ orderId, amountPkr, provider }) {
  throw new Error(
    `Payment provider "${provider}" is not configured yet. Add merchant credentials to .env ` +
    `and implement the API call in paymentProviders.js before enabling real payments.`
  );
}

async function verifyPaymentCallback(req) {
  // Each provider signs their callback payload differently (JazzCash uses a secure hash,
  // Easypaisa uses their own signature scheme) — validate that signature here before
  // trusting the callback and marking an order as paid.
  throw new Error('verifyPaymentCallback() not implemented — see notes at the top of this file.');
}

module.exports = { createPayment, verifyPaymentCallback };
