const loginPanel = document.getElementById('login-panel');
const chatPanel = document.getElementById('chat-panel');
const notice = document.getElementById('notice');
const log = document.getElementById('messages');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const conversation = [];
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed.');
  return value;
}
function show(authenticated) { loginPanel.hidden = authenticated; chatPanel.hidden = !authenticated; document.getElementById('logout').hidden = !authenticated; }
function add(role, content) {
  const item = document.createElement('div'); item.className = `message ${role}`;
  const label = document.createElement('strong'); label.textContent = role === 'user' ? 'You' : 'Aria';
  const text = document.createElement('p'); text.textContent = content;
  item.append(label, text); log.append(item); log.scrollTop = log.scrollHeight;
}
function clear() { conversation.length = 0; log.replaceChildren(); const welcome = document.createElement('p'); welcome.className = 'welcome'; welcome.textContent = 'Hi, I’m Aria. What would you like to work on?'; log.append(welcome); notice.textContent = ''; }
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('password').value }) }); document.getElementById('password').value = ''; show(true); const status = await api('/api/admin/session'); notice.textContent = status.ariaConfigured ? '' : 'Aria is not configured yet.'; }
  catch (error) { notice.textContent = error.message; }
});
document.getElementById('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const content = prompt.value.trim(); if (!content) return;
  prompt.value = ''; notice.textContent = ''; send.disabled = true; send.textContent = 'Aria is thinking…';
  add('user', content);
  const next = [...conversation, { role: 'user', content }].slice(-8);
  try {
    const result = await api('/api/admin/aria', { method: 'POST', body: JSON.stringify({ messages: next }) });
    add('assistant', result.reply); conversation.splice(0, conversation.length, ...next, { role: 'assistant', content: result.reply.slice(0, 1000) });
  } catch (error) { notice.textContent = error.message; prompt.value = content; }
  finally { send.disabled = false; send.textContent = 'Send to Aria'; prompt.focus(); }
});
document.getElementById('clear').addEventListener('click', clear);
document.getElementById('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); clear(); show(false); notice.textContent = 'Signed out.'; });
api('/api/admin/session').then(status => { show(status.authenticated); if (!status.configured) notice.textContent = 'Owner login must be configured first.'; else if (status.authenticated && !status.ariaConfigured) notice.textContent = 'Aria is not configured yet.'; }).catch(error => { notice.textContent = error.message; });
