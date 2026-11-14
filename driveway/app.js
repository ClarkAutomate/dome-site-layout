// Driveway grading in phone AR: walk the centreline tapping ground points, get the profile, the finished grade,
// fill depths, the culvert low spot and rough quantities, and see the finished road drawn over the ground.
// World frame = three.js / WebXR 'local' space, metres, +Y up. Reporting is in feet and inches.
import * as THREE from '../vendor/three.module.min.js';

const FT = 0.3048;
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function ftin(ft) { const neg = ft < 0; let i = Math.round(Math.abs(ft) * 12); const f = Math.floor(i / 12); i -= f * 12; return `${neg ? '-' : ''}${f}'-${i}"`; }
const sta = (ft) => { const r = Math.round(ft); return `${Math.floor(r / 100)}+${String(r % 100).padStart(2, '0')}`; };

// ---------- design parameters ----------
const P = Object.assign({ width: 12, depthIn: 12, mode: 'ease', maxGrade: 12, balance: 0, method: 'stand', slope: 2, baseIn: 6 }, store.get('ccdw_params2', {}));
const STEEP = 12.05;            // % grade flagged as steep for a gravel drive
const CLEAR_T = 1.35, BASE_T = 1.5;   // rough tons per cubic yard

// ---------- survey data ----------
let stations = [];           // {p: Vector3 (world, ground), walk: metres walked when tapped, culvert: true|false|undefined}
let closure = null;          // {horiz, vert, walked} in feet, after "Close loop"
let demo = false;

function compute() {
  const n = stations.length; if (!n) return null;
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(stations[i].p.x - stations[i - 1].p.x, stations[i].p.z - stations[i - 1].p.z) / FT);
  const g = stations.map((st) => (st.p.y - stations[0].p.y) / FT);
  const d = P.depthIn / 12, L = s[n - 1];
  let fin;
  if (P.mode === 'follow' || n < 2 || L < 0.5) fin = g.map((v) => v + d);
  else if (P.mode === 'ease') {
    // Follow the ground, but never steeper than the max grade. U = the lowest line that needs no cut, Lw = the highest
    // line that needs no fill; any blend of the two also keeps the grade limit, so "balance" trades fill for cut.
    const m = P.maxGrade / 100, a = P.balance / 100, t = g.map((v) => v + d);
    fin = t.map((_, i) => { let U = -Infinity, Lw = Infinity;
      for (let j = 0; j < n; j++) { const k = m * Math.abs(s[i] - s[j]); U = Math.max(U, t[j] - k); Lw = Math.min(Lw, t[j] + k); }
      return (1 - a) * U + a * Lw; });
  } else {   // one even slope end to end, lifted until the shallowest spot still has the full depth
    const line = (i) => g[0] + ((g[n - 1] - g[0]) * s[i]) / L;
    let lift = -Infinity; for (let i = 0; i < n; i++) lift = Math.max(lift, g[i] + d - line(i));
    fin = g.map((_, i) => line(i) + lift);
  }
  const fill = fin.map((v, i) => v - g[i]);
  const grade = []; for (let i = 0; i < n - 1; i++) grade.push(s[i + 1] - s[i] > 0.1 ? ((fin[i + 1] - fin[i]) / (s[i + 1] - s[i])) * 100 : 0);
  // culverts: ground low points with at least 6 in of rise on both sides, plus manual marks
  const auto = stations.map((st, i) => {
    if (i === 0 || i === n - 1) return false;
    const left = Math.max(...g.slice(0, i)), right = Math.max(...g.slice(i + 1));
    return g[i] <= g[i - 1] && g[i] <= g[i + 1] && Math.min(left, right) - g[i] >= 1.0;
  });   // one per dip: keep the lowest within 40 ft
  for (let i = 0; i < n; i++) if (auto[i]) for (let j = 0; j < n; j++) if (j !== i && auto[j] && Math.abs(s[i] - s[j]) < 40 && (g[j] < g[i] || (g[j] === g[i] && j < i))) { auto[i] = false; break; }
  const culvert = stations.map((st, i) => (st.culvert !== undefined ? st.culvert : auto[i]));
  const W = P.width, sl = P.slope, base = P.baseIn / 12;
  const area = (h) => (h > 0 ? W * h + sl * h * h : 0), wrap = (h) => (h > 0 ? W + (W + 2 * sl * h) + 2 * h * Math.hypot(1, sl) : 0);
  let fillCy = 0, cutCy = 0, fabric = 0;
  for (let i = 0; i < n - 1; i++) {
    const len = s[i + 1] - s[i];
    fillCy += ((area(fill[i]) + area(fill[i + 1])) / 2) * len / 27;
    cutCy += ((area(-fill[i]) + area(-fill[i + 1])) / 2) * len / 27;
    fabric += ((wrap(fill[i]) + wrap(fill[i + 1])) / 2) * len;
  }
  const baseCy = (W * base * L) / 27, stoneCy = Math.max(0, fillCy - baseCy);
  const culverts = culvert.map((c, i) => (c ? { i, len: W + 2 * sl * Math.max(0, fill[i]) + 2 } : null)).filter(Boolean);
  return { n, s, g, fin, fill, grade, culvert, culverts, L, fillCy, cutCy, baseCy, stoneCy, fabric: fabric * 1.1,
           maxFill: Math.max(...fill), minFill: Math.min(...fill), maxGrade: grade.length ? Math.max(...grade.map(Math.abs)) : 0,
           dams: Math.floor((L * FT) / 17.5) };
}

// ---------- mesh helpers ----------
class Tris {
  constructor() { this.p = []; }
  tri(a, b, c) { this.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  bar(a, b, r) {
    const ax = new THREE.Vector3().subVectors(b, a); if (ax.lengthSq() < 1e-9) return; ax.normalize();
    const ref = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ax, ref).normalize().multiplyScalar(r), v = new THREE.Vector3().crossVectors(ax, u).normalize().multiplyScalar(r);
    const c = [u.clone().add(v), u.clone().sub(v), u.clone().negate().sub(v), u.clone().negate().add(v)];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; this.quad(a.clone().add(c[i]), b.clone().add(c[i]), b.clone().add(c[j]), a.clone().add(c[j])); }
  }
  mesh(color, opacity = 1) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
  }
}
function label(text, color = '#ffffff', hM = 0.16) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d'), font = '600 64px system-ui,sans-serif'; ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 40; c.width = w; c.height = 92; ctx.font = font;
  ctx.fillStyle = 'rgba(10,14,18,.78)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(0, 0, w, 92, 22) : ctx.rect(0, 0, w, 92); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(text, w / 2, 48);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })); s.scale.set((hM * w) / 92, hM, 1); s.renderOrder = 10; return s;
}
function dispose(obj) { obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }

// ---------- scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.xr.enabled = true;
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500), BG = new THREE.Color(0x10161c);
const road = new THREE.Group(); scene.add(road);
const reticle = new THREE.Group(); reticle.visible = false; scene.add(reticle);
const retMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, side: THREE.DoubleSide, depthTest: false, transparent: true });
{ const ring = new THREE.Mesh(new THREE.RingGeometry(0.11, 0.14, 40), retMat); ring.rotation.x = -Math.PI / 2;
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.008, 1.0, 0.008), retMat); pole.position.y = 0.5; reticle.add(ring, pole); reticle.traverse((o) => { o.renderOrder = 20; }); }

function rebuild() {
  for (const c of [...road.children]) { road.remove(c); dispose(c); }
  const r = compute(); if (!r) return;
  const n = r.n, half = (P.width / 2) * FT, y0 = stations[0].p.y;
  const frame = stations.map((st, i) => {
    const a = stations[Math.max(0, i - 1)].p, b = stations[Math.min(n - 1, i + 1)].p;
    const t = new THREE.Vector3(b.x - a.x, 0, b.z - a.z); if (t.lengthSq() < 1e-6) t.set(0, 0, -1); t.normalize();
    const nrm = new THREE.Vector3(-t.z, 0, t.x), yf = y0 + r.fin[i] * FT, h = Math.max(0, r.fill[i]), toe = half + P.slope * h * FT;
    const at = (off, y) => new THREE.Vector3(st.p.x + nrm.x * off, y, st.p.z + nrm.z * off);
    return { c: at(0, yf), l: at(-half, yf), rr: at(half, yf), tl: at(-toe, st.p.y), tr: at(toe, st.p.y), g: st.p.clone(), nrm, toe };
  });
  const top = new Tris(), cut = new Tris(), side = new Tris(), edge = new Tris(), ground = new Tris(), posts = new Tris(), pipe = new Tris();
  for (let i = 0; i < n - 1; i++) {
    const a = frame[i], b = frame[i + 1], isCut = r.fill[i] < 0 || r.fill[i + 1] < 0;
    (isCut ? cut : top).quad(a.l, b.l, b.rr, a.rr);
    side.quad(a.l, b.l, b.tl, a.tl); side.quad(a.rr, b.rr, b.tr, a.tr);
    edge.bar(a.l, b.l, 0.02); edge.bar(a.rr, b.rr, 0.02); ground.bar(a.g, b.g, 0.02);
  }
  frame.forEach((f, i) => {
    posts.bar(f.g, f.c, 0.015);
    const steep = i < n - 1 && Math.abs(r.grade[i]) > STEEP, h = r.fill[i];
    const txt = `${sta(r.s[i])} · ${h >= 0 ? 'fill' : 'CUT'} ${ftin(Math.abs(h))}${i < n - 1 ? ` · ${r.grade[i] >= 0 ? '+' : ''}${r.grade[i].toFixed(1)}%` : ''}`;
    const lab = label(txt, h < 0 ? '#ff8a80' : steep ? '#ffd23f' : '#ffffff', 0.13); lab.position.copy(f.c).add(new THREE.Vector3(0, 0.45, 0)); road.add(lab);
    if (r.culvert[i]) {
      const ext = f.toe + 0.3, y = f.g.y + 0.25;
      pipe.bar(new THREE.Vector3(f.g.x - f.nrm.x * ext, y, f.g.z - f.nrm.z * ext), new THREE.Vector3(f.g.x + f.nrm.x * ext, y, f.g.z + f.nrm.z * ext), 0.23);
      const cl = label(`CULVERT · ${Math.ceil((2 * ext) / FT)} ft pipe`, '#8fd6ff', 0.16); cl.position.set(f.g.x, f.c.y + 0.9, f.g.z); road.add(cl);
    }
  });
  road.add(side.mesh(0x8a6a48, 0.35), top.mesh(0xd9d2c4, 0.5), cut.mesh(0xff5a4f, 0.5), edge.mesh(0xffb020), ground.mesh(0x3ddc84), posts.mesh(0xffffff), pipe.mesh(0x58c7ff, 0.9));
}

// ---------- text + profile ----------
function resultsText() {
  const r = compute(); const L = [];
  if (!r || r.n < 2) return 'Add at least two points along the centreline.';
  if (demo) L.push('DEMO DATA (made up). Start AR on site to survey the real driveway.', '');
  L.push(`Driveway ${Math.round(r.L)} ft long, ${P.width} ft wide, ${r.n} points`,
    `Grade: ${P.mode === 'even' ? 'one even slope end to end' : P.mode === 'follow' ? 'follows the ground' : `follows the ground, eased to ${P.maxGrade}% max, ${P.balance}% cut`}, ${P.depthIn} in of fill on gentle ground`,
    `Steepest grade ${r.maxGrade.toFixed(1)}%${r.maxGrade > STEEP ? '  << STEEP for gravel' : ''} · deepest fill ${ftin(r.maxFill)}${r.minFill < 0 ? ` · deepest cut ${ftin(-r.minFill)}` : ''}`);
  if (closure) L.push(`Loop closure: ${ftin(closure.vert)} vertical, ${ftin(closure.horiz)} horizontal over ${Math.round(closure.walked)} ft walked (corrected)`);
  else if (!demo) L.push('Loop NOT closed: elevations carry uncorrected phone drift.');
  L.push('', 'STA   GROUND  FINISH  FILL      GRADE');
  for (let i = 0; i < r.n; i++) L.push(`${sta(r.s[i]).padEnd(6)}${ftin(r.g[i]).padEnd(8)}${ftin(r.fin[i]).padEnd(8)}${((r.fill[i] < 0 ? 'cut ' : '') + ftin(Math.abs(r.fill[i]))).padEnd(10)}`
    + `${(i < r.n - 1 ? `${r.grade[i] >= 0 ? '+' : ''}${r.grade[i].toFixed(1)}%` : '').padEnd(7)}${r.culvert[i] ? 'culvert' : ''}`);
  L.push('', 'CULVERTS');
  if (!r.culverts.length) L.push('  none found (no dip of 6 in or more). Use "Culvert here" to add one.');
  for (const c of r.culverts) L.push(`  at ${sta(r.s[c.i])}: about ${Math.ceil(c.len)} ft of pipe under ${ftin(Math.max(0, r.fill[c.i]))} of fill. Size the diameter from the area that drains to it.`);
  L.push('', 'ROUGH QUANTITIES (2:1 side slopes, level ground across the road)',
    `  total fill        ${Math.round(r.fillCy)} cu yd`,
    `  road base ${P.baseIn} in    ${Math.round(r.baseCy)} cu yd  (~${Math.round(r.baseCy * BASE_T)} tons)`,
    `  clear stone       ${Math.round(r.stoneCy)} cu yd  (~${Math.round(r.stoneCy * CLEAR_T)} tons)`,
    `  cut               ${Math.round(r.cutCy)} cu yd`,
    `  geotextile wrap   ${Math.round(r.fabric)} sq ft (incl. 10% overlap)`,
    `  4 in perforated pipe  ${Math.round(r.L)} ft`,
    `  clay trench dams  ${r.dams} (one every 15-20 m)`);
  L.push('', 'Phone AR elevations can be off by a foot or more over a long walk. Check key heights with a laser or water level before ordering stone.');
  return L.join('\n');
}
function drawProfile() {
  const cv = $('profile'), r = compute(); const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, w, h);
  if (!r || r.n < 2) return;
  const lo = Math.min(...r.g, ...r.fin), hi = Math.max(...r.g, ...r.fin), pad = Math.max(0.5, (hi - lo) * 0.15), m = { l: 50, r: 10, t: 16, b: 22 };
  const X = (s) => m.l + (s / r.L) * (w - m.l - m.r), Y = (z) => h - m.b - ((z - lo + pad) / (hi - lo + 2 * pad)) * (h - m.t - m.b);
  c.font = '11px system-ui,sans-serif'; c.fillStyle = '#b8c4cc'; c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
  for (let k = 0; k <= 3; k++) { const z = lo + ((hi - lo) * k) / 3, y = Y(z); c.beginPath(); c.moveTo(m.l, y); c.lineTo(w - m.r, y); c.stroke(); c.textAlign = 'right'; c.fillText(`${z.toFixed(1)} ft`, m.l - 4, y + 4); }
  c.textAlign = 'left'; c.fillText('0+00', m.l, h - 6); c.textAlign = 'right'; c.fillText(sta(r.L), w - m.r, h - 6);
  c.beginPath(); r.s.forEach((s, i) => (i ? c.lineTo(X(s), Y(r.fin[i])) : c.moveTo(X(s), Y(r.fin[i])))); for (let i = r.n - 1; i >= 0; i--) c.lineTo(X(r.s[i]), Y(r.g[i])); c.closePath(); c.fillStyle = 'rgba(255,176,32,.22)'; c.fill();
  const line = (arr, col) => { c.beginPath(); r.s.forEach((s, i) => (i ? c.lineTo(X(s), Y(arr[i])) : c.moveTo(X(s), Y(arr[i])))); c.strokeStyle = col; c.lineWidth = 2; c.stroke(); };
  line(r.g, '#3ddc84'); line(r.fin, '#ffb020');
  c.fillStyle = '#f3f6f8'; c.textAlign = 'left'; c.fillText('finished grade', X(r.s[0]) + 6, Y(r.fin[0]) - 6); c.fillText('ground', X(r.s[0]) + 6, Y(r.g[0]) + 14);
  for (const k of r.culverts) { const x = X(r.s[k.i]), y = Y(r.g[k.i]); c.beginPath(); c.arc(x, y - 5, 5, 0, 7); c.fillStyle = '#58c7ff'; c.fill(); c.strokeStyle = '#10161c'; c.lineWidth = 2; c.stroke(); c.fillStyle = '#f3f6f8'; c.textAlign = 'center'; c.fillText('culvert', x, y + 14); }
}

// ---------- state ----------
let session = null, hitSource = null, refSpace = null, hitKind = 'none', uiHidden = false;
const camPos = new THREE.Vector3(), camDir = new THREE.Vector3(), lastCam = new THREE.Vector3(); let walked = 0, haveCam = false;
function setStatus(a, b = '') { $('status').innerHTML = `${a}${b ? `<small>${b}</small>` : ''}`; }
function show(id, on) { $(id).classList.toggle('hidden', !on); }
function changed(save = true) { rebuild(); updateReadout(); if (save) saveState(); }
function updateReadout() {
  const r = compute(), el = $('readout');
  if (!r) { el.textContent = session ? `ground: ${hitKind === 'plane' ? 'tracked' : 'searching…'}` : ''; return; }
  el.innerHTML = `${demo ? 'Demo · ' : ''}<b>${r.n}</b> points · <b>${Math.round(r.L)} ft</b> · deepest fill <b>${ftin(r.maxFill)}</b> · steepest <b>${r.maxGrade.toFixed(1)}%</b>\n`
    + `Fill <b>${Math.round(r.fillCy)} cu yd</b> · culverts <b>${r.culverts.length}</b>${session ? ` · ground ${hitKind === 'plane' ? 'tracked' : 'searching…'}` : ''}${closure ? ' · loop closed' : ''}`;
}
// saved in the frame of the first two points, so the survey can be restored from those two stakes
function axes() { const u = stations[1].p.clone().sub(stations[0].p); u.y = 0; u.normalize(); return { u, right: new THREE.Vector3(-u.z, 0, u.x) }; }
function saveState() {
  if (demo || stations.length < 2) return; const { u, right } = axes(), o = stations[0].p;
  store.set('ccdw_state', { when: new Date().toISOString(), closure, pts: stations.map((st) => { const l = st.p.clone().sub(o); return { a: l.dot(u), r: l.dot(right), h: l.y, c: st.culvert }; }) });
  store.set('ccdw_last', { when: new Date().toISOString(), text: resultsText() });
}
function restoreState() {
  const st = store.get('ccdw_state', null); if (!st || stations.length < 2) return; const { u, right } = axes(), o = stations[0].p.clone();
  stations = st.pts.map((k) => ({ p: o.clone().addScaledVector(u, k.a).addScaledVector(right, k.r).add(new THREE.Vector3(0, k.h, 0)), walk: 0, culvert: k.c === null ? undefined : k.c }));
  closure = st.closure || null; show('btnRestore', false); changed(false); setStatus(`Restored ${stations.length} saved points`, 'They are placed from your first two stakes. Check one against the ground before trusting it.');
}
function loadDemo() {
  demo = true; closure = null; stations = [];
  for (let i = 0; i <= 10; i++) { const s = i * 20, x = Math.sin(s / 70) * 14, dip = -3.2 * Math.exp(-(((s - 90) / 28) ** 2)), z = 0.03 * s + dip + 0.4 * Math.sin(s / 17);
    stations.push({ p: new THREE.Vector3(x * FT, z * FT, -s * FT), walk: s * FT }); }
  changed(false); fitPreview();
}

// ---------- actions ----------
let phoneH = 1.3;   // metres from the ground to the phone, set at the first point
function addPoint() {
  const standing = P.method === 'stand' && stations.length > 0;
  if (!standing && (!reticle.visible || hitKind !== 'plane')) { setStatus('No tracked ground under the ring', 'Sweep the phone slowly over the ground until the ring is green.'); return; }
  if (standing && !haveCam) { setStatus('Tracking not ready yet'); return; }
  if (closure) { closure = null; }
  if (!stations.length) { const h = camPos.y - reticle.position.y; phoneH = h > 0.6 && h < 2.0 ? h : 1.3; }
  // Standing method: the point is under the phone. Phone AR only finds flat patches, so the ring reads slopes as steps;
  // the phone's own height above its starting point does not have that problem.
  stations.push({ p: standing ? new THREE.Vector3(camPos.x, camPos.y - phoneH, camPos.z) : reticle.position.clone(), walk: walked });
  paintDesign();
  const r = compute(), i = r.n - 1; changed();
  setStatus(`Point ${r.n} at ${sta(r.s[i])}`, r.n === 1 ? (P.method === 'stand' ? `Phone height set to ${ftin(phoneH / FT)}. Hold it at that height, stand ON each next point and tap.` : 'Walk the centreline and add the next point.') : `Ground ${ftin(r.g[i])} vs the start. Keep going, then close the loop at the first stake.`);
  if (stations.length === 2) { const st = store.get('ccdw_state', null); if (st && st.pts && st.pts.length > 2) { $('btnRestore').textContent = `Restore ${st.pts.length} saved points (${new Date(st.when).toLocaleDateString()})`; show('btnRestore', true); } }
  else show('btnRestore', false);
}
function undo() { if (!stations.length) return; stations.pop(); closure = null; changed(); setStatus(`${stations.length} points`); }
function toggleCulvert() {
  const r = compute(); if (!r || !reticle.visible) { setStatus('Aim the ring at a surveyed point first'); return; }
  let best = -1, bd = 3.5; stations.forEach((st, i) => { const d = Math.hypot(st.p.x - reticle.position.x, st.p.z - reticle.position.z); if (d < bd) { bd = d; best = i; } });
  if (best < 0) { setStatus('No surveyed point within 10 ft of the ring', 'Aim at the point where the culvert should cross.'); return; }
  stations[best].culvert = !r.culvert[best]; changed(); setStatus(`${stations[best].culvert ? 'Culvert added' : 'Culvert removed'} at ${sta(r.s[best])}`);
}
function closeLoop() {
  if (stations.length < 3) { setStatus('Add more points first'); return; }
  const stand = P.method === 'stand';
  if (!stand && (!reticle.visible || hitKind !== 'plane')) { setStatus('Aim the ring at the FIRST stake', 'Wait for a green ring, then tap Close loop.'); return; }
  const here = stand ? new THREE.Vector3(camPos.x, camPos.y - phoneH, camPos.z) : reticle.position.clone();
  const mis = here.sub(stations[0].p), T = Math.max(walked, 0.01);
  if (Math.hypot(mis.x, mis.z) > 5) { setStatus('That is more than 16 ft from the first point', stand ? 'Walk back and stand on the first stake, phone at the same height.' : 'Walk back to the first stake and aim the ring at it.'); return; }
  for (const st of stations) st.p.addScaledVector(mis, -(st.walk / T));
  closure = { horiz: Math.hypot(mis.x, mis.z) / FT, vert: Math.abs(mis.y) / FT, walked: T / FT };
  changed(); setStatus(`Loop closed: ${ftin(closure.vert)} vertical, ${ftin(closure.horiz)} horizontal drift corrected`, 'Results now use the corrected elevations.');
}

// ---------- AR session ----------
async function startAR() {
  let s = null;
  try {
    s = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test', 'dom-overlay'], domOverlay: { root: $('overlay') } });
    s.addEventListener('end', onEnd);
    renderer.xr.setReferenceSpaceType('local'); await renderer.xr.setSession(s);
    session = s; scene.background = null;
    hitSource = await s.requestHitTestSource({ space: await s.requestReferenceSpace('viewer') });
    stations = []; closure = null; demo = false; walked = 0; haveCam = false; rebuild();
    show('intro', false); show('work', true); setStatus('Aim the ring at the first stake', 'Then tap "Add point". Sweep the phone slowly until the ring is green.'); updateReadout();
  } catch (e) { const msg = `Could not start AR: ${e && e.message ? e.message : e}`; if (s) { try { await s.end(); } catch { /* ended */ } } $('support').textContent = msg; }
}
function onEnd() {
  if (stations.length >= 2) saveState();
  session = null; hitSource = null; refSpace = null; hitKind = 'none'; reticle.visible = false; scene.background = BG; setUiHidden(false); openSheet(null);
  show('work', false); show('intro', true); show('btnRestore', false);
  if (!stations.length) loadDemo(); else fitPreview();
  if (store.get('ccdw_state', null)) show('btnLoad', true);
  setStatus(demo ? 'Driveway grading (demo data)' : 'Your surveyed driveway', 'Drag to look around. Results has the numbers.'); updateReadout(); resize();
}
function xrFrame(frame) {
  refSpace = renderer.xr.getReferenceSpace(); if (!refSpace) return;
  const vp = frame.getViewerPose(refSpace);
  if (vp) { const t = vp.transform; camPos.set(t.position.x, t.position.y, t.position.z);
    camDir.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w));
    if (haveCam) { const d = Math.hypot(camPos.x - lastCam.x, camPos.z - lastCam.z); if (d > 0.05 && d < 3) { walked += d; lastCam.copy(camPos); } else if (d >= 3) lastCam.copy(camPos); } else { lastCam.copy(camPos); haveCam = true; } }
  let got = false;
  if (hitSource) { const hits = frame.getHitTestResults(hitSource); if (hits.length) { const pose = hits[0].getPose(refSpace);
    if (pose) { reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z); got = true; } } }
  hitKind = got ? 'plane' : 'none'; reticle.visible = got && !uiHidden;
}

// ---------- preview camera ----------
const orbit = { az: 0.9, el: 0.5, dist: 40, pinch: 0 }, pts = new Map();
function placePreviewCamera() {
  const t = new THREE.Vector3(); if (stations.length) { for (const st of stations) t.add(st.p); t.multiplyScalar(1 / stations.length); }
  camera.position.set(t.x + orbit.dist * Math.cos(orbit.el) * Math.sin(orbit.az), t.y + orbit.dist * Math.sin(orbit.el), t.z + orbit.dist * Math.cos(orbit.el) * Math.cos(orbit.az)); camera.lookAt(t);
}
canvas.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, [e.clientX, e.clientY]); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || session) return; const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
  if (pts.size === 1) { orbit.az -= (e.clientX - prev[0]) * 0.006; orbit.el = Math.max(0.05, Math.min(1.5, orbit.el + (e.clientY - prev[1]) * 0.005)); }
  else if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (orbit.pinch) orbit.dist = Math.max(5, Math.min(300, (orbit.dist * orbit.pinch) / d)); orbit.pinch = d; }
});
const endPt = (e) => { pts.delete(e.pointerId); orbit.pinch = 0; };
canvas.addEventListener('pointerup', endPt); canvas.addEventListener('pointercancel', endPt);
canvas.addEventListener('wheel', (e) => { orbit.dist = Math.max(5, Math.min(300, orbit.dist * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: true });
function fitPreview() { let ext = 0; for (const a of stations) for (const b of stations) ext = Math.max(ext, a.p.distanceTo(b.p)); orbit.dist = Math.max(15, ext * 0.95); }
function resize() { if (renderer.xr.isPresenting) return; const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
window.addEventListener('resize', resize);
let lastRead = 0;
renderer.setAnimationLoop((time, frame) => { if (frame && session) { xrFrame(frame); if (time - lastRead > 500) { lastRead = time; updateReadout(); } } else placePreviewCamera(); renderer.render(scene, camera); });

// ---------- UI ----------
function openSheet(which) { show('sheet', !!which); show('sheetDesign', which === 'design'); show('sheetResults', which === 'results'); if (which === 'results') { $('resultsText').textContent = resultsText(); requestAnimationFrame(drawProfile); } if (which === 'design') paintDesign(); }
function setUiHidden(on) { uiHidden = on; document.body.classList.toggle('clean', on); if (on) { reticle.visible = false; const h = $('tapback').firstElementChild; h.style.animation = 'none'; void h.offsetWidth; h.style.animation = ''; } }
const MODES = ['ease', 'even', 'follow'];
function paintDesign() {
  $('pWidth').textContent = `${P.width} ft wide`; $('pDepth').textContent = `${P.depthIn} in fill`;
  $('pGrade').textContent = `${P.maxGrade}% max grade`; $('pBal').textContent = P.balance ? `${P.balance}% cut` : 'no cut';
  document.querySelectorAll('.easeOnly').forEach((e) => e.classList.toggle('hidden', P.mode !== 'ease'));
  $('pMode').textContent = { ease: 'Grade: ease the steep parts (tap to change)', even: 'Grade: one even slope (tap to change)', follow: 'Grade: follow the ground (tap to change)' }[P.mode];
  $('pModeHelp').textContent = { ease: 'Least earthwork. The road follows the ground and only leaves it where the ground is steeper than the max grade. "Cut" lets it dig into the high side there instead of only filling the low side.',
    even: 'A straight slope from the first point to the last, lifted until the shallowest spot still has the fill depth. Simple, but it buries every dip.',
    follow: 'The road sits the same height above the ground everywhere, so it is as steep as the land.' }[P.mode];
  $('pMethod').textContent = P.method === 'stand' ? 'Survey: stand on each point (best on slopes)' : 'Survey: aim the ring at each point';
  $('btnAdd').textContent = P.method === 'stand' && stations.length && session ? 'Add point where I stand' : 'Add point at ring';
}
$('btnStart').addEventListener('click', startAR); $('btnAdd').addEventListener('click', addPoint); $('btnUndo').addEventListener('click', undo);
$('btnCulvert').addEventListener('click', toggleCulvert); $('btnClose').addEventListener('click', closeLoop); $('btnRestore').addEventListener('click', restoreState);
let exitArmed = 0;
$('btnExit').addEventListener('click', () => { if (stations.length && Date.now() - exitArmed > 4000) { exitArmed = Date.now(); $('btnExit').textContent = 'Tap again to exit (points are saved)'; setTimeout(() => { $('btnExit').textContent = 'Exit AR'; }, 4000); return; } if (session) session.end(); });
document.querySelectorAll('.jsDesign').forEach((b) => b.addEventListener('click', () => openSheet('design')));
document.querySelectorAll('.jsResults').forEach((b) => b.addEventListener('click', () => openSheet('results')));
document.querySelectorAll('.jsCloseSheet').forEach((b) => b.addEventListener('click', () => openSheet(null)));
document.querySelectorAll('.jsHide').forEach((b) => b.addEventListener('click', () => { openSheet(null); setUiHidden(true); }));
$('tapback').addEventListener('click', () => setUiHidden(false));
document.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.p, v = P[k] + Number(b.dataset.d), lim = { width: [8, 24], depthIn: [0, 120], maxGrade: [4, 25], balance: [0, 100] }[k]; P[k] = Math.max(lim[0], Math.min(lim[1], v));
  store.set('ccdw_params2', P); paintDesign(); changed();
}));
$('pMode').addEventListener('click', () => { P.mode = MODES[(MODES.indexOf(P.mode) + 1) % MODES.length]; store.set('ccdw_params2', P); paintDesign(); changed(); });
$('pMethod').addEventListener('click', () => { P.method = P.method === 'stand' ? 'ring' : 'stand'; store.set('ccdw_params2', P); paintDesign(); });
function loadSaved() {
  const st = store.get('ccdw_state', null); if (!st || !st.pts || st.pts.length < 2) return false;
  demo = false; closure = st.closure || null;
  stations = st.pts.map((k) => ({ p: new THREE.Vector3(k.r, k.h, -k.a), walk: 0, culvert: k.c === null ? undefined : k.c }));
  rebuild(); updateReadout(); fitPreview(); setStatus(`Your survey of ${new Date(st.when).toLocaleDateString()}`, 'Open Design to try different grades, then Results.'); return true;
}
$('btnLoad').addEventListener('click', loadSaved);
$('btnClear').addEventListener('click', () => { stations = []; closure = null; demo = false; if (!session) loadDemo(); else changed(false); openSheet(null); });
$('btnCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('resultsText').textContent); $('btnCopy').textContent = 'Copied'; } catch { $('btnCopy').textContent = 'Long-press the text to copy'; } setTimeout(() => { $('btnCopy').textContent = 'Copy text'; }, 2500); });

async function boot() {
  scene.background = BG; resize(); paintDesign();
  if (store.get('ccdw_state', null)) show('btnLoad', true);
  if (!loadSaved()) { loadDemo(); setStatus('Driveway grading (demo data)', 'Drag to look around. Start AR on site to survey the real one.'); }
  let ok = false, why = '';
  if (!window.isSecureContext) why = 'Open this page over https for AR to work.';
  else if (!navigator.xr) why = 'This browser has no WebXR. Use Chrome on the Pixel.';
  else { try { ok = await navigator.xr.isSessionSupported('immersive-ar'); } catch { ok = false; } if (!ok) why = 'AR is not available here. On the Pixel, use Chrome.'; }
  $('btnStart').disabled = !ok; $('support').textContent = why;
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('../sw.js').catch(() => {});
}
boot();
window.__dw = { THREE, compute, resultsText, P, get stations() { return stations; }, set stations(v) { stations = v; demo = false; changed(false); }, closeSim(mis, T) { walked = T; reticle.visible = true; hitKind = 'plane'; reticle.position.copy(stations[0].p).add(mis); closeLoop(); reticle.visible = false; } };
