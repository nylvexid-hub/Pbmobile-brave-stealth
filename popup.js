'use strict';

const output = document.querySelector('#status');
const diagBox = document.querySelector('#diag');
const armButton = document.querySelector('#arm');
const stopButton = document.querySelector('#stop');

const currentTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const showStatus = async () => {
  const tab = await currentTab();
  if (!tab?.id) { output.textContent = 'Tab tidak ditemukan.'; return; }
  const key = 'status_' + tab.id;
  const saved = (await chrome.storage.local.get(key))[key];
  output.textContent = saved?.detail || 'Belum disiapkan.';

  const res = await chrome.runtime.sendMessage({ type: 'diag', tabId: tab.id });
  const d = res?.diag;
  if (!d) { diagBox.textContent = 'diagnostik: belum ada'; return; }
  diagBox.textContent =
    'bundle: ' + (d.bundles || 0) +
    '  patch: ' + ((d.lastApplied && d.lastApplied.join('+')) || '—') +
    '\nsri: ' + (d.documentPatched ? 'dilepas' : 'tidak perlu') +
    '  bytes: ' + (d.lastBytes || 0) +
    (d.lastError ? '\nerror: ' + d.lastError : '');
};

const send = async (type) => {
  const tab = await currentTab();
  if (!tab?.id) { output.textContent = 'Tab tidak ditemukan.'; return; }
  output.textContent = 'Memproses…';
  const response = await chrome.runtime.sendMessage({ type, tabId: tab.id });
  output.textContent = response?.ok
    ? (type === 'arm' ? 'Siap. Masuk match sekarang.' : 'Dibatalkan.')
    : (response?.error || 'Gagal.');
  await showStatus();
};

armButton.addEventListener('click', () => send('arm').catch((e) => { output.textContent = e.message; }));
stopButton.addEventListener('click', () => send('stop').catch((e) => { output.textContent = e.message; }));
showStatus().catch((e) => { output.textContent = e.message; });
