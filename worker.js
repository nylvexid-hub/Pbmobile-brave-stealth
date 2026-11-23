'use strict';

/*
 * Bundle patcher for pbmobile.app  —  v0.8.0 (fixed)
 *
 * FIXES vs 0.7.0
 *  1. Gate patching is regex-based. The old literal list ('Ka&&(window.G=',
 *     '!1&&(window.G=') only ever matched two specific minified builds; any
 *     redeploy renamed the guard variable and the extension aborted with
 *     "Gate bundle berubah". Minified guard names rotate, the *shape* does not.
 *  2. Losing Network.loadingFinished no longer kills the session. The old code
 *     detached on a missing networkId, which switched Fetch off for the rest of
 *     the tab — every later match then loaded the untouched bundle.
 *  3. The localhost/test-build gates are unlocked too (the bundle hides the
 *     engine behind a hostname check on production hosts).
 *  4. Every patch decision is written to chrome.storage as a diagnostic record,
 *     so popup.js can say *why* nothing happened instead of "Gate bundle berubah".
 *
 * It still never touches detector functions by name, and never forges
 * server-validated claims.
 */

const sessions = new Map();
const gamePattern = '*pbmobile.app/static/game/bundle.js*';
const matchPattern = '*pbmobile.app/jogo*';
const autoKey = (tabId) => 'auto_' + tabId;
const diagKey = (tabId) => 'diag_' + tabId;

// Guard shapes, not guard names: `X&&(window.G=` / `X&&window.G=` / `X&&(window.G =`
const RE_GATE_G = /([A-Za-z0-9_$]+)\s*&&\s*(\(?\s*window\.G\s*=)/g;
const RE_GATE_RND = /([A-Za-z0-9_$]+)\s*&&\s*(\(?\s*window\.RND\s*=)/g;
// `vt=f.has("test")&&/^(localhost|127\.0\.0\.1)$/.test(location.hostname)`
const RE_HOST_MODERN = /([A-Za-z0-9_$]+)\s*=\s*[^;]{0,120}?localhost[^;]{0,120}?\.test\(location\.hostname\)/g;
// `const Ui="localhost"===location.hostname...`
const RE_HOST_LEGACY = /((?:let|const|var)?\s*)([A-Za-z0-9_$]+)\s*=\s*["']localhost["']\s*===\s*location\.hostname[^;,\n]*/g;
const RE_HOST_REGEX = /\/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\//g;

const isGameUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'pbmobile.app' || parsed.hostname.endsWith('.pbmobile.app'));
  } catch (_) {
    return false;
  }
};

const isLobbyUrl = (url) => {
  if (!isGameUrl(url)) return false;
  try { return !new URL(url).pathname.startsWith('/jogo'); } catch (_) { return false; }
};

const setStatus = async (tabId, status, detail = '') => {
  await chrome.storage.local.set({ ['status_' + tabId]: { status, detail, at: Date.now() } });
  const text = status === 'ready' ? 'ON' : status === 'patched' ? 'OK' : status === 'error' ? '!' : '';
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: status === 'error' ? '#b13c3c' : '#2f7d4f' });
  } catch (_) {}
};

const setDiag = async (tabId, patch) => {
  const key = diagKey(tabId);
  const prev = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({ [key]: Object.assign(prev, patch, { at: Date.now() }) });
};

const detach = async (tabId, status, detail = '') => {
  const session = sessions.get(tabId);
  if (session) {
    session.done = true;
    clearTimeout(session.timer);
    sessions.delete(tabId);
  }
  try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable'); } catch (_) {}
  try { await chrome.debugger.sendCommand({ tabId }, 'Network.disable'); } catch (_) {}
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  await setStatus(tabId, status, detail);
};

const arm = async (tabId, reload = true) => {
  const tab = await chrome.tabs.get(tabId);
  if (!isGameUrl(tab.url)) return { ok: false, error: 'Buka pbmobile.app dulu.' };
  if (sessions.has(tabId)) return { ok: true };
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: true });
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [
        { urlPattern: matchPattern, resourceType: 'Document', requestStage: 'Response' },
        { urlPattern: gamePattern, resourceType: 'Script', requestStage: 'Response' }
      ]
    });
    sessions.set(tabId, { timer: null, done: false, busy: false, networkId: null, documentPatched: false, bundles: 0 });
    await setDiag(tabId, { armedAt: Date.now(), lastError: null });
    await setStatus(tabId, 'ready', 'Otomatis siap untuk match berikutnya.');
    if (reload) await chrome.tabs.reload(tabId, { bypassCache: true });
    return { ok: true };
  } catch (error) {
    await detach(tabId, 'error', error.message || 'Gagal menyiapkan debugger.');
    return { ok: false, error: error.message || 'Gagal menyiapkan debugger.' };
  }
};

const decodeBody = (response) => {
  if (!response.base64Encoded) return response.body;
  const binary = atob(response.body);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const encodeBody = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
};

const patchMatchDocument = (html) => {
  let changed = false;
  const out = html.replace(/<script\b[^>]*>/gi, (tag) => {
    if (!/\bsrc\s*=\s*["'][^"']*\/static\/game\/bundle\.js(?:\?[^"']*)?["']/i.test(tag)) return tag;
    if (!/\sintegrity\s*=/i.test(tag)) return tag;
    changed = true;
    return tag.replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*')/i, '');
  });
  return { html: out, changed };
};

const cleanHeaders = (headers) => (headers || []).filter((header) =>
  !['content-length', 'content-encoding', 'transfer-encoding', 'etag', 'content-md5']
    .includes(header.name.toLowerCase()));

/* The heart of the fix: unlock by shape, not by minified name. */
const patchBundle = (source) => {
  let text = source;
  const applied = [];

  const gMatches = text.match(RE_GATE_G);
  if (gMatches && gMatches.length) {
    text = text.replace(RE_GATE_G, (_m, _name, tail) => '!0&&' + tail);
    applied.push('G' + (gMatches.length > 1 ? 'x' + gMatches.length : ''));
  } else if (/!0\s*&&\s*\(?\s*window\.G\s*=/.test(text)) {
    applied.push('G-open');
  }

  const rMatches = text.match(RE_GATE_RND);
  if (rMatches && rMatches.length) {
    text = text.replace(RE_GATE_RND, (_m, _name, tail) => '!0&&' + tail);
    applied.push('RND');
  } else if (/!0\s*&&\s*\(?\s*window\.RND\s*=/.test(text)) {
    applied.push('RND-open');
  }

  let hostHits = 0;
  text = text.replace(RE_HOST_MODERN, (_m, name) => { hostHits++; return name + '=!0'; });
  text = text.replace(RE_HOST_LEGACY, (_m, kw, name) => { hostHits++; return (kw || '') + name + '=!0'; });
  const regexHits = (text.match(RE_HOST_REGEX) || []).length;
  if (regexHits) { text = text.replace(RE_HOST_REGEX, '/.*/'); hostHits += regexHits; }
  if (hostHits) applied.push('HOST' + (hostHits > 1 ? 'x' + hostHits : ''));

  return { text, applied, changed: text !== source };
};

const handlePaused = async (tabId, params) => {
  const session = sessions.get(tabId);
  if (!session || session.done) return;
  if (session.busy) {
    try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId: params.requestId }); } catch (_) {}
    return;
  }
  session.busy = true;
  const target = { tabId };
  const requestId = params.requestId;
  try {
    if (params.responseStatusCode !== 200) {
      await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId });
      session.busy = false;
      return;
    }
    const response = await chrome.debugger.sendCommand(target, 'Fetch.getResponseBody', { requestId });
    const original = decodeBody(response);
    const path = new URL(params.request.url).pathname;

    if (params.resourceType === 'Document' && path.startsWith('/jogo')) {
      const doc = patchMatchDocument(original);
      await chrome.debugger.sendCommand(target, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: cleanHeaders(params.responseHeaders),
        body: encodeBody(doc.html)
      });
      session.documentPatched = doc.changed;
      session.busy = false;
      await setDiag(tabId, { documentPatched: doc.changed, documentAt: Date.now() });
      await setStatus(tabId, 'ready', doc.changed
        ? 'Halaman match disiapkan (SRI dilepas); menunggu bundle.'
        : 'Halaman match tanpa integrity; menunggu bundle.');
      return;
    }

    const result = patchBundle(original);
    session.networkId = params.networkId || null;
    session.bundles = (session.bundles || 0) + 1;

    await chrome.debugger.sendCommand(target, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: cleanHeaders(params.responseHeaders),
      body: encodeBody(result.text)
    });

    await setDiag(tabId, {
      bundles: session.bundles,
      lastApplied: result.applied,
      lastBytes: original.length,
      lastChanged: result.changed,
      lastError: result.applied.length ? null : 'tak ada guard yang cocok'
    });

    const unlocked = result.applied.some((n) => n.startsWith('G'));
    if (!unlocked) {
      /* Keep the session: the next match may carry a guard this build does not,
         and detaching here used to switch the whole tab off. */
      await setStatus(tabId, 'error', 'Bundle dimuat, tapi guard window.G tidak ditemukan di build ini.');
      session.busy = false;
      return;
    }

    await setStatus(tabId, 'patched', 'Bundle di-patch (' + result.applied.join('+') + ').');
    session.busy = false;

    if (session.networkId) {
      clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        setStatus(tabId, 'patched', 'Bundle di-patch; konfirmasi load tidak diterima, tapi sesi tetap aktif.').catch(() => {});
      }, 8000);
    }
  } catch (error) {
    session.busy = false;
    try { await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId }); } catch (_) {}
    await setDiag(tabId, { lastError: error.message || String(error) });
    await setStatus(tabId, 'error', (error.message || 'Gagal memproses bundle.'));
  }
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  if (method === 'Fetch.requestPaused') {
    handlePaused(source.tabId, params).catch(() => {});
    return;
  }
  const session = sessions.get(source.tabId);
  if (!session || session.done) return;
  if (!session.networkId || params.requestId !== session.networkId) return;
  if (method === 'Network.loadingFinished') {
    clearTimeout(session.timer);
    session.timer = null;
    session.networkId = null;
  } else if (method === 'Network.loadingFailed') {
    clearTimeout(session.timer);
    session.timer = null;
    session.networkId = null;
    setDiag(source.tabId, { lastError: 'bundle gagal dimuat: ' + (params.errorText || '?') }).catch(() => {});
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  const session = sessions.get(source.tabId);
  if (!session || session.done) return;
  clearTimeout(session.timer);
  sessions.delete(source.tabId);
  setStatus(source.tabId, 'error', 'Debugger terlepas. Tekan Siapkan lagi.').catch(() => {});
});

const autoArmLobby = async (tabId, url) => {
  if (!isLobbyUrl(url) || sessions.has(tabId)) return;
  const saved = await chrome.storage.local.get(autoKey(tabId));
  if (saved[autoKey(tabId)] !== true) return;
  await arm(tabId, false);
};

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  autoArmLobby(tabId, tab.url).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([autoKey(tabId), 'status_' + tabId, diagKey(tabId)]).catch(() => {});
});

chrome.tabs.query({}).then((tabs) => {
  for (const tab of tabs) if (tab.id != null) autoArmLobby(tab.id, tab.url).catch(() => {});
}).catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (!Number.isInteger(message?.tabId)) return false;
  if (message.type === 'arm') {
    chrome.storage.local.set({ [autoKey(message.tabId)]: true })
      .then(() => arm(message.tabId))
      .then(reply, (error) => reply({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'stop') {
    chrome.storage.local.remove(autoKey(message.tabId))
      .then(() => detach(message.tabId, 'idle', 'Mode otomatis dimatikan.'))
      .then(() => reply({ ok: true }), (error) => reply({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'diag') {
    const key = diagKey(message.tabId);
    chrome.storage.local.get(key)
      .then((d) => reply({ ok: true, diag: d[key] || null }))
      .catch(() => reply({ ok: false }));
    return true;
  }
  return false;
});
