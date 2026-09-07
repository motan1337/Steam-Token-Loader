'use strict';

const bridge = window.api;
const $ = (id) => document.getElementById(id);

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function unwrap(res) {
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'Unknown error');
  return res.data;
}

async function refreshStatus() {
  try {
    const s = unwrap(await bridge.status());
    $('admin-banner').classList.toggle('hidden', s.elevated);
    if (!s.steamFound) setStatus('Steam not found. Install it and sign in once first.', 'warn');
    else setStatus('');
  } catch (_) {}
}

async function login() {
  if (!bridge) { setStatus('window.api is missing the preload script did not load.', 'err'); return; }
  const line = $('token').value.trim();
  if (!line) { setStatus('Paste a token first.', 'err'); return; }
  const btn = $('login-btn');
  btn.disabled = true;
  setStatus('Working… stopping Steam and applying the token.');
  try {
    const data = unwrap(await bridge.login(line));
    let msg = data.message;
    if (data.client_audience === false) {
      msg += '  note: this looks like a web token, it may not sign the desktop client in.';
      setStatus(msg, 'warn');
    } else {
      setStatus(msg, 'ok');
    }
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

$('login-btn').addEventListener('click', login);
$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) login();
});
$('admin-restart').addEventListener('click', () => bridge && bridge.restartAdmin().catch(() => {}));

if (!bridge) setStatus('window.api is missing the preload script did not load.', 'err');
else refreshStatus();
