const status = document.getElementById('checkout-status');
const capture = document.getElementById('capture');
const params = new URLSearchParams(location.search);
const token = params.get('token');
if (params.has('cancel')) status.textContent = 'The test payment was cancelled.';
else if (!token || !/^[A-Za-z0-9-]{5,64}$/.test(token)) status.textContent = 'No PayPal test order was returned.';
else { status.textContent = 'PayPal returned your test order. Complete the sandbox capture below.'; capture.hidden = false; }
capture.addEventListener('click', async () => {
  capture.disabled = true; status.textContent = 'Verifying sandbox payment…';
  try {
    const response = await fetch('/api/checkout/sandbox/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Payment could not be verified.');
    status.textContent = 'Sandbox payment completed. No real money moved.';
    capture.hidden = true;
    history.replaceState(null, '', '/checkout.html');
  } catch (error) { status.textContent = `${error.message} If your owner session ended, sign in again and return to this page.`; capture.disabled = false; }
});
