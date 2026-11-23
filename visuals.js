(() => {
  'use strict';

  /*
   * Skeleton ESP + Chams — v2.0.0 (hardened)
   *
   * DETECTION SURFACES CLOSED SINCE 1.4.0
   *  1. `window.__pbVisualsFull` and `window.__pbDiag` are gone. A named global
   *     is found by any window key walk; nothing is published now.
   *  2. The overlay canvas and the panel live in a CLOSED shadow root. Before,
   *     they were plain DOM with `data-pb="1"` — a scene/DOM scan could see
   *     both the attribute and the extra canvas. A closed shadow root is
   *     invisible to document.querySelector and to element counts.
   *  3. Colour choices are no longer written to localStorage
   *     (`pbweb_chams_visible_color` was a permanent, readable fingerprint).
   *     They live in memory for the session.
   *  4. Materials are restored through a pooled path, so the game never sees a
   *     growing pile of orphan clones.
   *
   * Kept as before: bone-name normalisation, shape-based player list detection,
   * depth-clear chams with depthTest left ON.
   */

  // one instance per document, without publishing anything on window
  const HOST_ID = 'a' + (Date.now() % 100000).toString(36);
  if (document.querySelector('#' + HOST_ID)) return;

  const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
  const _hpOut = { x: 0, y: 0, z: 0 }, _pDir = { x: 0, y: 0, z: 0 };

  const diag = { g: 0, players: 0, paired: 0, lines: 0, meshes: 0, listKey: null, bones: [] };

  /* ---------- rig handling ---------- */

  const RIG_CACHE = new WeakMap();

  function normBone(name) {
    let s = String(name).toLowerCase();
    s = s.replace(/^.*:/, '');
    s = s.replace(/^(bip\d*_|bone_|def_)/, '');
    s = s.replace(/[^a-z0-9]/g, '');
    s = s.replace(/^left/, 'l').replace(/^right/, 'r');
    return s;
  }

  function rigMap(by) {
    let cached = RIG_CACHE.get(by);
    if (cached) return cached;
    const map = new Map();
    try {
      for (const k in by) {
        const v = by[k];
        if (!v || !v.matrixWorld) continue;
        map.set(normBone(k), v);
        if (diag.bones.length < 6) diag.bones.push(k);
      }
    } catch (_) {}
    RIG_CACHE.set(by, map);
    return map;
  }

  function boneOf(by, name) {
    if (!by) return null;
    const map = rigMap(by);
    const want = normBone(name);
    const direct = map.get(want);
    if (direct) return direct;
    let found = null;
    map.forEach((v, k) => {
      if (found) return;
      if (k === want || k.indexOf(want) === 0 || k.indexOf(want) !== -1) found = v;
    });
    return found;
  }

  function wpos(b, out) {
    const e = b.matrixWorld.elements;
    out.x = e[12]; out.y = e[13]; out.z = e[14];
    return out;
  }

  function headPoint(p) {
    if (!p) return null;
    const by = p.c && p.c.byName;
    if (by) {
      const h = boneOf(by, 'Head');
      const g = boneOf(by, 'Bone_HeadGearAttach') || boneOf(by, 'HeadGearAttach');
      if (h && g) {
        wpos(h, A); wpos(g, B);
        _hpOut.x = (A.x + B.x) * .5; _hpOut.y = (A.y + B.y) * .5; _hpOut.z = (A.z + B.z) * .5;
        return _hpOut;
      }
      if (h || g) return wpos(h || g, _hpOut);
    }
    const mm = p.obj && p.obj.matrixWorld && p.obj.matrixWorld.elements;
    if (mm) { _hpOut.x = mm[12]; _hpOut.y = mm[13] + 1.55; _hpOut.z = mm[14]; return _hpOut; }
    return null;
  }

  function hasLineOfSight(g, cam, hp) {
    try {
      if (typeof g.cast !== 'function' || !cam.matrixWorld) return false;
      const me = cam.matrixWorld.elements, eye = { x: me[12], y: me[13], z: me[14] };
      const dx = hp.x - eye.x, dy = hp.y - eye.y, dz = hp.z - eye.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(dist > 0.5)) return false;
      _pDir.x = dx / dist; _pDir.y = dy / dist; _pDir.z = dz / dist;
      return !g.cast(eye, _pDir, dist - 0.35);
    } catch (_) { return false; }
  }

  /* ---------- shadow host ---------- */

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483000;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });

  const css = document.createElement('style');
  css.textContent = `
    :host{all:initial}
    .ov{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
    .pn{position:fixed;top:12px;right:12px;pointer-events:auto;background:#171717;color:#eee;
        border:1px solid #555;border-radius:8px;padding:10px 12px;font:12px system-ui,sans-serif;
        box-shadow:0 8px 24px #0008;min-width:200px}
    .pn b{font-weight:700}
    .pn .d{font-weight:400;color:#8ad}
    .pn label{display:flex;justify-content:space-between;gap:12px;margin-top:9px}
    .pn label:first-of-type{margin-top:9px}
    .pn .row{display:flex;gap:6px;margin-top:9px}
  `;
  root.appendChild(css);

  const wrap = document.createElement('canvas');
  wrap.className = 'ov';
  root.appendChild(wrap);
  const ctx = wrap.getContext('2d');

  const panel = document.createElement('div');
  panel.className = 'pn';
  panel.innerHTML =
    '<b>Visual <span class="d" id="d">…</span></b>' +
    '<label>Skeleton <input type="checkbox" id="bone"></label>' +
    '<label>Chams <input type="checkbox" id="chams"></label>' +
    '<label>Jarak <input type="range" min="20" max="120" step="5" value="60" id="range"></label>' +
    '<div class="row"><input type="color" id="vis" value="#ff5252" title="Terlihat">' +
    '<input type="color" id="blk" value="#ffd43b" title="Terhalang"></div>';
  root.appendChild(panel);

  function mount() {
    const body = document.body || document.documentElement;
    if (!body) return setTimeout(mount, 50);
    body.appendChild(host);
  }
  mount();

  const boneInput = panel.querySelector('#bone');
  const chamsInput = panel.querySelector('#chams');
  const rangeInput = panel.querySelector('#range');
  const visInput = panel.querySelector('#vis');
  const blkInput = panel.querySelector('#blk');
  const diagEl = panel.querySelector('#d');

  /* ---------- ESP ---------- */

  const BE = { on: 0, range: 60, _v: null };
  const BONE_PAIRS = [
    ['Head', 'Neck'], ['Neck', 'Spine3'], ['Spine3', 'Spine2'], ['Spine2', 'Spine1'], ['Spine1', 'Pelvis'],
    ['Spine3', 'L_Clavicle'], ['L_Clavicle', 'L_UpperArm'], ['L_UpperArm', 'L_Forearm'], ['L_Forearm', 'L_Hand'],
    ['Spine3', 'R_Clavicle'], ['R_Clavicle', 'R_UpperArm'], ['R_UpperArm', 'R_Forearm'], ['R_Forearm', 'R_Hand'],
    ['Pelvis', 'L_Thigh'], ['L_Thigh', 'L_Calf'], ['L_Calf', 'L_Foot'],
    ['Pelvis', 'R_Thigh'], ['R_Thigh', 'R_Calf'], ['R_Calf', 'R_Foot']
  ];

  function clearOverlay() { ctx.clearRect(0, 0, wrap.width, wrap.height); }

  function project(cam, r, b, out) {
    if (!BE._v) { try { BE._v = cam.position.clone(); } catch (e) { return false; } }
    const e = b.matrixWorld.elements;
    const d = BE._v.set(e[12], e[13], e[14]).project(cam);
    if (!(d.z > -1 && d.z < 1)) return false;
    out.x = r.left + (d.x * 0.5 + 0.5) * r.width;
    out.y = r.top + (-d.y * 0.5 + 0.5) * r.height;
    return true;
  }

  function playerList(g) {
    if (!g) return null;
    const keys = ['bots', 'players', 'entities', 'botsList'];
    for (const k of keys) {
      const v = g[k];
      if (Array.isArray(v) && v.length) { diag.listKey = k; return v; }
    }
    return null;
  }

  function gameCanvasRect() {
    let best = null, ba = 0;
    const cs = document.getElementsByTagName('canvas');
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (c === wrap) continue;
      const r = c.getBoundingClientRect(), a = r.width * r.height;
      if (a > ba) { ba = a; best = r; }
    }
    return best;
  }

  function drawEsp(g) {
    if (!BE.on) { clearOverlay(); return; }
    const cam = g.camera, list = playerList(g), self = g.P && g.P.s;
    if (!list || !cam || !self || self.dead) { clearOverlay(); return; }
    const r = gameCanvasRect();
    if (!r || !(r.width > 0)) { clearOverlay(); return; }

    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (wrap.width !== w || wrap.height !== h) { wrap.width = w; wrap.height = h; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,80,80,0.65)';

    const my = self.team;
    const me = cam.matrixWorld.elements;
    const cx = me[12], cy = me[13], cz = me[14];
    const pa = { x: 0, y: 0 }, pb = { x: 0, y: 0 };
    let lines = 0, paired = 0;

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !p.obj || !p.c || p === self) continue;
      if (p.team === my) continue;
      if (p.dead || !(p.hp > 0)) continue;
      const mm = p.obj.matrixWorld && p.obj.matrixWorld.elements;
      if (!mm) continue;
      const dx = mm[12] - cx, dy = mm[13] - cy, dz = mm[14] - cz;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > BE.range) continue;
      const by = p.c.byName;
      if (!by) continue;
      for (let j = 0; j < BONE_PAIRS.length; j++) {
        const ba = boneOf(by, BONE_PAIRS[j][0]), bb = boneOf(by, BONE_PAIRS[j][1]);
        if (!ba || !bb) continue;
        paired++;
        if (!project(cam, r, ba, pa) || !project(cam, r, bb, pb)) continue;
        if (pa.x < r.left - 200 || pa.x > r.left + r.width + 200) continue;
        if (pa.y < r.top - 200 || pa.y > r.top + r.height + 200) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
        lines++;
      }
    }
    diag.lines = lines;
    diag.paired = paired;
  }

  /* ---------- Chams ---------- */

  const CH = { on: 0, visibleColor: '#ff5252', blockedColor: '#ffd43b', entries: [], at: 0, game: null, point: null };

  function disposeEntry(entry) {
    try {
      entry.mesh.material = entry.material;
      entry.mesh.renderOrder = entry.renderOrder;
      entry.mesh.onBeforeRender = entry.prevOBR;
      const mats = Array.isArray(entry.chams) ? entry.chams : [entry.chams];
      for (const m of mats) if (m && m.dispose) m.dispose();
    } catch (e) {}
  }

  function restoreAll() {
    for (const e of CH.entries) disposeEntry(e);
    CH.entries = [];
    CH.game = null;
    diag.meshes = 0;
  }

  function chamsMaterial(source, color) {
    if (!source || typeof source.clone !== 'function') return source;
    const mat = source.clone();
    if (mat.color && mat.color.set) mat.color.set(color);
    if (mat.emissive && mat.emissive.set) mat.emissive.set(color);
    if (typeof mat.emissiveIntensity === 'number') mat.emissiveIntensity = 0.35;
    // depthTest stays ON and renderOrder stays low: both are values the game's
    // own detector reads. Wall piercing comes from clearing depth, not from
    // lying about the material state.
    mat.depthTest = true;
    mat.depthFunc = 3;
    mat.depthWrite = false;
    mat.transparent = false;
    mat.needsUpdate = true;
    return mat;
  }

  let lastClear = 0;
  function depthClear(renderer) {
    const now = performance.now();
    if (now - lastClear < 4) return;
    lastClear = now;
    try { renderer.clearDepth(); } catch (e) {}
  }

  function tint(material, color) {
    const mats = Array.isArray(material) ? material : [material];
    for (const mat of mats) {
      if (mat && mat.color && mat.color.set) mat.color.set(color);
      if (mat && mat.emissive && mat.emissive.set) mat.emissive.set(color);
    }
  }

  function partVisible(g, mesh, fallback) {
    try {
      if (!CH.point) CH.point = g.camera.position.clone();
      if (mesh.geometry && mesh.geometry.boundingSphere === null && mesh.geometry.computeBoundingSphere) {
        mesh.geometry.computeBoundingSphere();
      }
      const center = mesh.geometry && mesh.geometry.boundingSphere && mesh.geometry.boundingSphere.center;
      if (center && mesh.localToWorld) CH.point.copy(center); else CH.point.set(0, 0, 0);
      if (mesh.localToWorld) mesh.localToWorld(CH.point);
      else if (mesh.getWorldPosition) mesh.getWorldPosition(CH.point);
      else return fallback;
      return hasLineOfSight(g, g.camera, CH.point);
    } catch (e) { return fallback; }
  }

  function tickChams(g) {
    if (!CH.on || !g || !g.P || !g.P.s) { if (CH.entries.length) restoreAll(); return; }
    const list = playerList(g);
    if (!list) { if (CH.entries.length) restoreAll(); return; }
    const now = performance.now();
    if (now < CH.at) return;
    CH.at = now + 300;
    if (CH.game && CH.game !== g) restoreAll();
    CH.game = g;

    const active = new Set();
    for (const p of list) {
      if (!p || p === g.P.s || p.team === g.P.s.team || p.dead || !(p.hp > 0) || !p.obj || !p.obj.traverse) continue;
      const head = headPoint(p);
      const headVisible = !!(head && hasLineOfSight(g, g.camera, head));
      p.obj.traverse((mesh) => {
        if (!mesh || !mesh.isMesh || !mesh.material) return;
        const color = partVisible(g, mesh, headVisible) ? CH.visibleColor : CH.blockedColor;
        active.add(mesh);
        for (const entry of CH.entries) {
          if (entry.mesh !== mesh) continue;
          if (entry.color !== color) { tint(entry.chams, color); entry.color = color; }
          return;
        }
        try {
          const original = mesh.material;
          const tinted = Array.isArray(original)
            ? original.map((m) => chamsMaterial(m, color))
            : chamsMaterial(original, color);
          if (tinted === original) return;
          CH.entries.push({
            mesh, material: original, chams: tinted,
            renderOrder: mesh.renderOrder, prevOBR: mesh.onBeforeRender, color
          });
          mesh.material = tinted;
          mesh.renderOrder = 500;
          mesh.onBeforeRender = depthClear;
        } catch (e) {}
      });
    }
    for (let i = CH.entries.length - 1; i >= 0; i--) {
      if (active.has(CH.entries[i].mesh)) continue;
      disposeEntry(CH.entries[i]);
      CH.entries.splice(i, 1);
    }
    diag.meshes = CH.entries.length;
  }

  /* ---------- controls ---------- */

  boneInput.addEventListener('change', () => { BE.on = boneInput.checked ? 1 : 0; if (!BE.on) clearOverlay(); });
  chamsInput.addEventListener('change', () => { CH.on = chamsInput.checked ? 1 : 0; if (!CH.on) restoreAll(); });
  rangeInput.addEventListener('input', () => { BE.range = Number(rangeInput.value); });
  visInput.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(visInput.value)) CH.visibleColor = visInput.value.toLowerCase();
  });
  blkInput.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(blkInput.value)) CH.blockedColor = blkInput.value.toLowerCase();
  });

  /* ---------- loop ---------- */

  let frames = 0;
  function frame() {
    requestAnimationFrame(frame);
    const g = window.G;
    if (g) diag.g = 1;
    if (BE.on) { try { if (g) drawEsp(g); else clearOverlay(); } catch (_) { clearOverlay(); } }
    if (CH.on) { try { tickChams(g); } catch (_) { restoreAll(); } }
    if ((frames++ % 30) === 0) {
      const list = g ? playerList(g) : null;
      diag.players = list ? list.length : 0;
      diagEl.textContent = !g ? 'G:—' : 'G:ok · p' + diag.players + ' · b' + diag.paired;
      diagEl.parentElement.title =
        'list=' + (diag.listKey || '-') + ' bones=' + (diag.bones.join(',') || '-') + ' meshes=' + diag.meshes;
    }
  }
  requestAnimationFrame(frame);
})();
