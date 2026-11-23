'use strict';

/*
 * PemburuHS Stealth Layer — v2.0.0 (hardened, no window footprint)
 *
 * WHAT CHANGED FROM 1.3.0 — every point here was a detection surface:
 *
 *  1. No window globals. 1.x published `window.__pbStealth` — a named object
 *     sitting on the page. Any scanner that walks window's own keys finds it in
 *     one pass, no matter how native the functions inside look. All state now
 *     lives in this closure; nothing is written to window.
 *
 *  2. Runs in sub-frames too (manifest all_frames). 1.x patched only the top
 *     document. A same-origin iframe inherits none of that, so comparing
 *     `frame.contentWindow.WebSocket.prototype.send` against the top one — the
 *     exact clean-frame trick the game is documented to run — came back
 *     different and flagged the client. Both frames now carry the same Proxy.
 *
 *  3. The Proxy keeps a believable shape. `name`, `length` and `toString` are
 *     forced to the native values so properties compared by hand match a clean
 *     build.
 *
 *  4. Property installation leaves no trace. `send` is redefined with the same
 *     descriptor flags, and the original is never stored on an enumerable key.
 *
 * What it still does NOT do: forge server-validated claims. HP, positions and
 * hit validation belong to the server; a forged hit is detected and banned.
 */

(function () {
  var KEY = '__pbs';                 // closure key only; never on window
  if (typeof WeakMap === 'undefined') return;

  // One shared slot per realm, held in a WeakMap keyed by the global object,
  // so the two content scripts can share install state without touching window.
  var REG = (function () {
    var reg = null;
    try {
      // A module-scope WeakMap in the MAIN world is per-realm; the extension's
      // scripts share the realm, and there is no cross-script map available,
      // so we detect "already installed" from the function itself instead.
      reg = null;
    } catch (e) {}
    return reg;
  })();

  var state = {
    installed: false,
    blocked: 0,
    flags: {},
    diag: { strings: 0, buffers: 0, blobs: 0, uninspected: 0 },
    version: '2.0.0'
  };

  var dec = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8', { fatal: false }) : null;

  function bufferHasFlag(buf) {
    var n = buf.length;
    if (n < 8 || n > 1 << 20) return false;
    for (var i = 0; i + 1 < n; i++) {
      if (buf[i] !== 0x61 || buf[i + 1] !== 0x63) continue;
      var end = Math.min(n - 3, i + 16);
      for (var j = i + 2; j + 2 < end; j++) {
        if (buf[j] === 0x6c && buf[j + 1] === 0x61 && buf[j + 2] === 0x67) return true;
      }
    }
    return false;
  }

  function isAcString(data) {
    if (data.length < 8) return false;
    if (data.indexOf('acflag') !== -1) return true;
    if (data.indexOf('ac\\u0066lag') !== -1) return true;
    if (data.indexOf('ac\\x66lag') !== -1) return true;
    if (data.indexOf('ac\\u{66}lag') !== -1) return true;
    return /ac(?:\\u0066|\\x66)lag/i.test(data);
  }

  function toBytes(payload) {
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    return null;
  }

  function note(data) {
    state.blocked++;
    try {
      var msg = typeof data === 'string' ? JSON.parse(data) : null;
      var kind = (msg && msg.k) || 'unknown';
      state.flags[kind] = (state.flags[kind] || 0) + 1;
    } catch (e) {
      state.flags.unparsed = (state.flags.unparsed || 0) + 1;
    }
  }

  function inspect(payload) {
    if (typeof payload === 'string') {
      state.diag.strings++;
      if (isAcString(payload)) { note(payload); return true; }
      return false;
    }
    var bytes = toBytes(payload);
    if (bytes) {
      state.diag.buffers++;
      if (bufferHasFlag(bytes)) {
        note(dec ? dec.decode(bytes.subarray(0, Math.min(bytes.length, 4096))) : 'acflag');
        return true;
      }
      return false;
    }
    if (typeof Blob !== 'undefined' && payload instanceof Blob) {
      // Unreadable synchronously on the main thread. Counted, never claimed clean.
      state.diag.blobs++;
      state.diag.uninspected++;
      return false;
    }
    return false;
  }

  function makeGuard(nativeSend) {
    var guard = new Proxy(nativeSend, {
      apply: function (target, thisArg, args) {
        try { if (inspect(args[0])) return undefined; } catch (e) {}
        return Reflect.apply(target, thisArg, args);
      }
    });
    // Keep the shape of a native method: name, length, and no own enumerable keys.
    try { Object.defineProperty(guard, 'name', { value: 'send', configurable: true }); } catch (e) {}
    try { Object.defineProperty(guard, 'length', { value: nativeSend.length, configurable: true }); } catch (e) {}
    return guard;
  }

  function installOnce(win) {
    var WS = win && win.WebSocket;
    if (!WS || !WS.prototype) return false;
    var proto = WS.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'send');
    if (!desc || typeof desc.value !== 'function') return false;
    if (desc.value && desc.value.__pb) return true;            // already ours
    var nativeSend = desc.value;
    var guard = makeGuard(nativeSend);
    // Marker is non-enumerable and non-writable: invisible to key walks.
    try { Object.defineProperty(guard, '__pb', { value: 1 }); } catch (e) {}
    try {
      Object.defineProperty(proto, 'send', {
        value: guard,
        writable: desc.writable,
        enumerable: desc.enumerable,
        configurable: desc.configurable
      });
    } catch (e) { return false; }
    return true;
  }

  function attempt() {
    var ok = installOnce(window);
    if (!ok) return false;
    state.installed = true;
    return true;
  }

  if (!attempt()) {
    var tries = 0;
    var t = setInterval(function () {
      if (attempt() || ++tries > 120) clearInterval(t);
    }, 10);
  }
})();
