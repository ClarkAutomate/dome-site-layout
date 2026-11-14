// On-site AR layout for the dome + deck. Geometry comes from layout.json (tools/ar_export.py).
// Model frame: feet, origin at the dome centre, +x east, +y north, z up.  three.js frame: metres, +Y up.
//   model (x, y, z) ft  ->  three (x, z, -y) * 0.3048
import * as THREE from './vendor/three.module.min.js';

const FT = 0.3048;
const $ = (id) => document.getElementById(id);
const V = (x, y, z = 0) => new THREE.Vector3(x * FT, z * FT, -y * FT);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- formatting ----------
function ftin(ft) {
  const neg = ft < 0; let inches = Math.round(Math.abs(ft) * 12);
  const f = Math.floor(inches / 12); inches -= f * 12;
  return `${neg ? '-' : ''}${f}'-${inches}"`;
}

// ---------- plan geometry (model feet) ----------
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToPoly(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

// ---------- mesh builders (everything is unlit, thick enough to read outdoors) ----------
class Tris {
  constructor() { this.p = []; }
  tri(a, b, c) { this.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  // flat strip of width w (ft) along model points [[x,y],...] at height z (ft)
  ribbon(pts, z, w, closed = true) {
    const n = pts.length, last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const ex = (dx / L) * w / 2, ey = (dy / L) * w / 2;   // extend the ends so corners close
      const nx = (-dy / L) * w / 2, ny = (dx / L) * w / 2;
      this.quad(V(a[0] - ex + nx, a[1] - ey + ny, z), V(b[0] + ex + nx, b[1] + ey + ny, z),
                V(b[0] + ex - nx, b[1] + ey - ny, z), V(a[0] - ex - nx, a[1] - ey - ny, z));
    }
  }
  // square-section bar between two three.js points, r in metres
  bar(a, b, r) {
    const ax = new THREE.Vector3().subVectors(b, a);
    if (ax.lengthSq() < 1e-9) return;
    ax.normalize();
    const ref = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ax, ref).normalize().multiplyScalar(r);
    const v = new THREE.Vector3().crossVectors(ax, u).normalize().multiplyScalar(r);
    const c = [u.clone().add(v), u.clone().sub(v), u.clone().negate().sub(v), u.clone().negate().add(v)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(a.clone().add(c[i]), b.clone().add(c[i]), b.clone().add(c[j]), a.clone().add(c[j]));
    }
  }
  disc(x, y, z, rFt, seg = 24) {
    const c = V(x, y, z);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      this.tri(c, V(x + rFt * Math.cos(a0), y + rFt * Math.sin(a0), z), V(x + rFt * Math.cos(a1), y + rFt * Math.sin(a1), z));
    }
  }
  fan(pts, z) {   // convex polygon fill
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      this.tri(V(cx, cy, z), V(a[0], a[1], z), V(b[0], b[1], z));
    }
  }
  prism(pts, z0, z1) {   // closed box under a convex outline
    this.fan(pts, z1);
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length];
      this.quad(V(a[0], a[1], z0), V(b[0], b[1], z0), V(b[0], b[1], z1), V(a[0], a[1], z1)); }
  }
  lit(color, opacity = 1) {   // shaded (needs the scene lights); flat facets
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
  }
  mesh(color, opacity = 1) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    return new THREE.Mesh(g, m);
  }
}
function circlePts(r, n = 72) {
  return Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)]);
}
function label(text, color = '#ffffff', hM = 0.16) {
  const c = document.createElement('canvas'); const ctx = c.getContext('2d');
  const font = '600 64px system-ui,sans-serif'; ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 40; c.width = w; c.height = 92;
  ctx.font = font; ctx.fillStyle = 'rgba(10,14,18,.78)';
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(0, 0, w, 92, 22) : ctx.rect(0, 0, w, 92); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(text, w / 2, 48);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set((hM * w) / 92, hM, 1); s.renderOrder = 10;
  return s;
}
function dispose(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
}

// ---------- build one design ----------
const COL = { deck: 0xffb020, pier: 0xff4fd8, beam: 0x7bd3ff, dome: 0xffffff, door: 0x3ddc84, extra: 0x58c7ff, clear: 0xff5a4f };
// Deck-height override (inches above the ground at stake 1). null = the design's own height.
function withDeckHeight(g, deckIn) {
  if (deckIn == null) return g;
  const top = deckIn / 12, n = Math.max(1, Math.ceil(deckIn / 7.75) - 1);   // risers <= 7-3/4 in, one tread fewer than risers
  const steps = g.steps.map((s) => { const [a, b, c, d] = s; const L = Math.hypot(d[0] - a[0], d[1] - a[1]) || 1, run = (n * 11) / 12;
    const out = (p, q) => [p[0] + ((q[0] - p[0]) / L) * run, p[1] + ((q[1] - p[1]) / L) * run]; return [a, b, out(b, c), out(a, d)]; });
  return { ...g, deck_top_ft: top, dome_base_ft: top + (g.curb_ft || 0), steps, steps_treads: g.steps.map(() => n) };
}
function buildDesign(g) {
  const root = new THREE.Group(); const L = {};
  const layer = (name) => { const grp = new THREE.Group(); grp.name = name; root.add(grp); L[name] = grp; return grp; };
  const top = g.deck_top_ft, base = g.dome_base_ft;

  // deck: outline on the ground, outline at deck height, corner posts, faint surface
  { const grp = layer('deck'); let t = new Tris();
    t.ribbon(g.outline, 0.02, 0.25); t.ribbon(g.outline, top, 0.25);
    for (const p of g.outline) { t.bar(V(p[0], p[1], 0), V(p[0], p[1], top), 0.03); t.bar(V(p[0], p[1], -4), V(p[0], p[1], 6.5), 0.012); }
    grp.add(t.mesh(COL.deck));
    t = new Tris(); t.fan(g.outline, top); grp.add(t.mesh(COL.deck, 0.16));
    const s = g.outline.reduce((m, p) => (p[1] < m[1] ? p : m));   // label near the door side
    const lab = label(`${g.label} · ${Math.round(g.area_sqft)} sq ft`, '#ffcf70', 0.2);
    lab.position.copy(V(0, s[1] - 1.2, top + 0.6)); grp.add(lab);
  }
  // piers: footing disc on the ground + a short post + id
  { const grp = layer('piers'); const t = new Tris();
    for (const p of g.piers) {
      t.disc(p.x, p.y, 0.03, p.dia_in / 24);
      t.bar(V(p.x, p.y, 0), V(p.x, p.y, top - 0.9), 0.04);
      t.bar(V(p.x, p.y, -4), V(p.x, p.y, 6.5), 0.01);   // plumb line: same plan spot whatever the ground does
      const lab = label(`${p.id} ${p.dia_in}"`, '#ffb3ee', 0.12); lab.position.copy(V(p.x, p.y, 0.75)); grp.add(lab);
    }
    grp.add(t.mesh(COL.pier, 0.85));
  }
  { const grp = layer('beams'); const t = new Tris();
    for (const b of g.beams) t.bar(V(b[0], b[1], top - 0.9), V(b[2], b[3], top - 0.9), 0.03);
    grp.add(t.mesh(COL.beam));
  }
  // dome: struts at true size, base ring on the deck + its shadow on the ground, door frame
  { const grp = layer('dome'); let t = new Tris();
    const H = g.dome.hubs.map((h) => V(h[0], h[1], h[2] + base));
    for (const [a, b] of g.dome.struts) t.bar(H[a], H[b], 0.02);
    const ring = circlePts(g.dome.radius_ft);
    t.ribbon(ring, base, 0.15);
    grp.add(t.mesh(COL.dome));
    t = new Tris(); t.ribbon(ring, 0.02, 0.2); grp.add(t.mesh(COL.dome, 0.6));
    t = new Tris();
    const [j1, j2] = g.door.jambs, dh = g.door.height_ft;
    t.bar(V(j1[0], j1[1], base), V(j1[0], j1[1], base + dh), 0.04);
    t.bar(V(j2[0], j2[1], base), V(j2[0], j2[1], base + dh), 0.04);
    t.bar(V(j1[0], j1[1], base + dh), V(j2[0], j2[1], base + dh), 0.04);
    grp.add(t.mesh(COL.door));
    if ((g.dome.bay || []).length) {   // bay window: outline every clear panel, faint blue fill
      const tb = new Tris(), tf = new Tris(); let sx = 0, sy = 0, sz = 0;
      for (const k of g.dome.bay) { const [a, b, c] = g.dome.panels[k]; tb.bar(H[a], H[b], 0.035); tb.bar(H[b], H[c], 0.035); tb.bar(H[c], H[a], 0.035); tf.tri(H[a], H[b], H[c]);
        for (const i of [a, b, c]) { sx += g.dome.hubs[i][0]; sy += g.dome.hubs[i][1]; sz = Math.max(sz, g.dome.hubs[i][2]); } }
      grp.add(tb.mesh(0x58c7ff)); grp.add(tf.mesh(0x58c7ff, 0.18));
      const n = g.dome.bay.length * 3, bl = label('BAY WINDOW', '#a8e3ff', 0.2); bl.position.copy(V((sx / n) * 1.08, (sy / n) * 1.08, base + sz + 0.8)); grp.add(bl);
    }
    const az = (g.door.az_deg * Math.PI) / 180, r = g.dome.radius_ft;
    const dl = label('DOOR', '#9df5c0', 0.2); dl.position.copy(V(Math.sin(az) * r, Math.cos(az) * r, base + dh + 0.6)); grp.add(dl);
    const cl = label(`dome centre · ${ftin(g.dome.height_ft)} tall`, '#ffffff', 0.14); cl.position.copy(V(0, 0, base + 0.5)); grp.add(cl);
    t = new Tris(); t.bar(V(0, 0, 0), V(0, 0, base + g.dome.height_ft), 0.015); t.disc(0, 0, 0.03, 0.4); grp.add(t.mesh(COL.dome, 0.7));
  }
  { const grp = layer('extras'); const t = new Tris();
    for (const s of g.steps) t.ribbon(s, 0.02, 0.2);
    if (g.station) {
      t.ribbon(g.station.pad, 0.02, 0.2);
      for (const tote of g.station.totes) {
        t.ribbon(tote, 4.0, 0.12);
        for (const p of tote) t.bar(V(p[0], p[1], 0), V(p[0], p[1], 4.0), 0.02);
      }
      const c = g.station.pad.reduce((s, p) => [s[0] + p[0] / g.station.pad.length, s[1] + p[1] / g.station.pad.length], [0, 0]);
      const lab = label('water station', '#a8e3ff', 0.14); lab.position.copy(V(c[0], c[1], 4.6)); grp.add(lab);
    }
    grp.add(t.mesh(COL.extra));
  }
  // shaded model: solid deck, posts, steps, white cover with clear window + skylight panels, door
  { const grp = layer('shaded'); let t = new Tris();
    t.prism(g.outline, top - 0.77, top - 0.01); grp.add(t.lit(0xb5895a));
    t = new Tris(); for (const p of g.piers) t.bar(V(p.x, p.y, -0.5), V(p.x, p.y, top - 0.77), 0.09); grp.add(t.lit(0x9a9a94));
    t = new Tris();
    g.steps.forEach((s, i) => { const n = (g.steps_treads && g.steps_treads[i]) || 2; const [a, b, c, d] = s;
      const mix = (p, q, f) => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
      for (let k = 0; k < n; k++) t.prism([mix(a, d, k / n), mix(b, c, k / n), mix(b, c, (k + 1) / n), mix(a, d, (k + 1) / n)], 0, top * (1 - (k + 1) / (n + 1))); });
    grp.add(t.lit(0xa37c50));
    const H = g.dome.hubs.map((h) => V(h[0], h[1], h[2] + base));
    const zMax = Math.max(...g.dome.hubs.map((h) => h[2])), apex = g.dome.hubs.findIndex((h) => h[2] === zMax);
    const cover = new Tris(), glass = new Tris();
    const bay = new Set(g.dome.bay || []), frame = new Tris();
    (g.dome.panels || []).forEach((tri, k) => {
      const win = bay.has(k), sky = g.dome.skylight && tri.includes(apex);
      (win || sky ? glass : cover).tri(H[tri[0]], H[tri[1]], H[tri[2]]);
      if (win) { frame.bar(H[tri[0]], H[tri[1]], 0.02); frame.bar(H[tri[1]], H[tri[2]], 0.02); frame.bar(H[tri[2]], H[tri[0]], 0.02); }
    });
    grp.add(cover.lit(0xf4f2ec)); grp.add(glass.lit(0x5f9fc2, 0.62)); grp.add(frame.lit(0xe9e6dc));
    t = new Tris(); const ring = circlePts(g.dome.radius_ft + 0.05); t.ribbon(ring, base, 0.3); grp.add(t.lit(0xd8d4c8));
    const [j1, j2] = g.door.jambs, dh = g.door.height_ft, az = (g.door.az_deg * Math.PI) / 180, ox = Math.sin(az) * 0.35, oy = Math.cos(az) * 0.35;
    t = new Tris(); t.quad(V(j1[0] + ox, j1[1] + oy, base), V(j2[0] + ox, j2[1] + oy, base), V(j2[0] + ox, j2[1] + oy, base + dh), V(j1[0] + ox, j1[1] + oy, base + dh)); grp.add(t.lit(0x4a3b2c));
    t = new Tris();
    for (const j of [j1, j2]) t.bar(V(j[0] + ox, j[1] + oy, base), V(j[0] + ox, j[1] + oy, base + dh), 0.05);
    t.bar(V(j1[0] + ox, j1[1] + oy, base + dh), V(j2[0] + ox, j2[1] + oy, base + dh), 0.05); grp.add(t.lit(0xe9e6dc));
    if (g.station) { t = new Tris(); for (const tote of g.station.totes) t.prism(tote, 0.5, 4.2); grp.add(t.lit(0xf2f5f7, 0.75)); }
  }
  { const grp = layer('clear'); const t = new Tris(); t.ribbon(g.clear_ring, 0.02, 0.2); grp.add(t.mesh(COL.clear, 0.8)); }
  return { root, layers: L };
}

// ---------- scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.xr.enabled = true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
const PREVIEW_BG = new THREE.Color(0x10161c);

const anchorGroup = new THREE.Group();   // follows the XR anchor (tracking corrections)
const site = new THREE.Group();          // the real site: stakes + tree marks + the model
const model = new THREE.Group();         // the layout being nudged
const marksGroup = new THREE.Group();
const stakesGroup = new THREE.Group();
scene.add(anchorGroup); anchorGroup.add(site); site.add(model, marksGroup, stakesGroup);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8f8676, 2.2));
{ const sun = new THREE.DirectionalLight(0xfff4e0, 2.0); sun.position.set(6, 10, 4); scene.add(sun); }   // morning sun from the east side
const previewGrid = new THREE.GridHelper(30, 30, 0x35505f, 0x22323c);
scene.add(previewGrid);

// reticle: ring + centre dot + a thin vertical pole so it reads on leaf litter
const reticle = new THREE.Group(); reticle.visible = false; scene.add(reticle);
const retMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, side: THREE.DoubleSide, depthTest: false, transparent: true });
{ const ring = new THREE.Mesh(new THREE.RingGeometry(0.11, 0.14, 40), retMat); ring.rotation.x = -Math.PI / 2;
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.02, 16), retMat); dot.rotation.x = -Math.PI / 2;
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.008, 1.0, 0.008), retMat); pole.position.y = 0.5;
  reticle.add(ring, dot, pole); reticle.traverse((o) => { o.renderOrder = 20; }); }

let DATA = null, design = null, built = null;
const layerOn = store.get('ccdome_ar_layers', { deck: true, piers: true, beams: false, dome: true, extras: true, clear: false });

let deckIn = store.get('ccdome_ar_deckin', null);
function deckInches() { return deckIn == null ? Math.round(design.deck_top_ft * 12) : deckIn; }
function setDeckIn(v) {
  deckIn = v == null ? null : Math.max(6, Math.min(96, Math.round(v)));
  if (deckIn != null && Math.abs(deckIn - design.deck_top_ft * 12) < 0.5) deckIn = null;
  store.set('ccdome_ar_deckin', deckIn); rebuild(); updateReadout(); saveSnapshot();
}
function rebuild() {
  if (built) { model.remove(built.root); dispose(built.root); }
  built = buildDesign(withDeckHeight(design, deckIn)); model.add(built.root); applyLayers();
  const h = deckInches(), note = h > 30 ? ' · needs guards' : '';
  document.querySelectorAll('.jsDeckH').forEach((b) => { b.innerHTML = `${h}" deck<span class="lbl">${deckIn == null ? 'as designed' : 'tap to reset'}${note}</span>`; });
}
function setDesign(name) {
  design = DATA.designs.find((d) => d.name === name) || DATA.designs[0];
  rebuild();
  store.set('ccdome_ar_design', design.name);
  for (const id of ['design', 'design2']) $(id).value = design.name;
  refreshMarks(); updateReadout();
}
let shaded = store.get('ccdome_ar_shaded', false), uiHidden = false;
const SOLID_HIDES = ['deck', 'dome', 'beams', 'piers', 'extras'];   // line layers the shaded model replaces
function applyLayers() {
  for (const [k, grp] of Object.entries(built.layers)) grp.visible = k === 'shaded' ? shaded : !!layerOn[k] && !(shaded && SOLID_HIDES.includes(k));
  document.querySelectorAll('.jsShade').forEach((b) => { b.textContent = shaded ? 'Show lines' : 'Show shaded model'; });
  document.querySelectorAll('[data-layer]').forEach((c) => { c.checked = !!layerOn[c.dataset.layer]; });
}

// ---------- state ----------
let state = 'preview';            // preview | center | door | adjust
let session = null, refSpace = null, viewerSpace = null, hitSource = null, anchor = null, anchorLive = false;
let lastHit = null, hitKind = 'none';        // 'plane' = real hit test, 'level' = estimated on the layout's ground level
const camPos = new THREE.Vector3(), camDir = new THREE.Vector3();
const stake1 = new THREE.Vector3(), stake2 = new THREE.Vector3();   // site-local
let haveStake2 = false;
const marks = [];                 // {id, pos: Vector3 (site-local), obj}
let markSeq = 0;
const STEPS = [{ ft: 1 / 12, deg: 0.5, name: '1"' }, { ft: 0.5, deg: 2, name: '6"' }, { ft: 1, deg: 5, name: "1'" }];
let stepIx = 1;

// Edit an object's WORLD transform, whatever its parent is doing.
function editWorld(obj, fn) { const parent = obj.parent; scene.attach(obj); fn(obj); parent.attach(obj); }
function worldOf(obj, localV) { obj.updateWorldMatrix(true, false); return localV.clone().applyMatrix4(obj.matrixWorld); }
function yawOf(obj) { const q = new THREE.Quaternion(); obj.getWorldQuaternion(q); return new THREE.Euler().setFromQuaternion(q, 'YXZ').y; }
// model-frame feet (x east, y north, z up) of a world point
function toModelFt(worldV) { const p = model.worldToLocal(worldV.clone()); return [p.x / FT, -p.z / FT, p.y / FT]; }
function doorLocalYaw() { const az = (design.door.az_deg * Math.PI) / 180; return Math.atan2(Math.sin(az), -Math.cos(az)); }

function setStatus(main, sub = '') { $('status').innerHTML = `${main}${sub ? `<small>${sub}</small>` : ''}`; }
function show(id, on) { $(id).classList.toggle('hidden', !on); }
function setState(s) {
  state = s;
  show('intro', s === 'preview'); show('place', s === 'center' || s === 'door'); show('adjust', s === 'adjust');
  model.visible = s !== 'center'; marksGroup.visible = stakesGroup.visible = s !== 'preview' && s !== 'center';
  if (s === 'center') { $('btnPlace').textContent = 'Set dome centre here'; setStatus('Step 1: aim the ring at the centre stake', 'Sweep the phone slowly over the ground until a green ring appears.'); }
  if (s === 'door') { $('btnPlace').textContent = 'Door faces this way'; setStatus('Step 2: aim the ring where the door should face', 'Walk to the second stake (at least 5 ft from the centre). The layout turns to follow the ring.'); }
  if (s === 'adjust') setStatus('Nudge the layout, then mark trees', 'Arrows move it relative to where you are looking. On a slope, stand over a pier pole and look straight down to see its true spot.');
  updateReadout();
}

// ---------- stakes + marks ----------
function stakeMarker(text, color) {
  const g = new THREE.Group(); const t = new Tris();
  t.bar(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.2, 0), 0.012); g.add(t.mesh(color));
  const l = label(text, '#ffffff', 0.12); l.position.set(0, 1.32, 0); g.add(l); return g;
}
function redrawStakes() {
  for (const c of [...stakesGroup.children]) { stakesGroup.remove(c); dispose(c); }
  const a = stakeMarker('stake 1 (centre)', 0x3ddc84); a.position.copy(stake1); stakesGroup.add(a);
  if (haveStake2) { const b = stakeMarker('stake 2 (door)', 0x3ddc84); b.position.copy(stake2); stakesGroup.add(b); }
}
function classify(markLocal) {
  const [x, y] = toModelFt(worldOf(site, markLocal));
  const r = Math.hypot(x, y), domeGap = r - design.dome.radius_ft;
  const inside = pointInPoly([x, y], design.outline), edge = distToPoly([x, y], design.outline);
  let level, text;
  if (domeGap < 0.5) { level = 'bad'; text = domeGap < 0 ? `INSIDE dome by ${ftin(-domeGap)}` : `${ftin(domeGap)} from dome ring`; }
  else if (inside) { level = 'bad'; text = `in deck, ${ftin(edge)} from edge, ${ftin(domeGap)} to dome`; }
  else if (edge < 3) { level = 'warn'; text = `${ftin(edge)} outside deck`; }
  else { level = 'ok'; text = `${ftin(edge)} outside deck`; }
  return { x, y, r, domeGap, inside, edge, level, text };
}
const LEVEL = { bad: ['#ff5a4f', 0xff5a4f], warn: ['#ffd23f', 0xffd23f], ok: ['#3ddc84', 0x3ddc84] };
function drawMark(m) {
  if (m.obj) { marksGroup.remove(m.obj); dispose(m.obj); }
  const c = classify(m.pos); m.info = c;
  const g = new THREE.Group(); const t = new Tris();
  t.bar(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2.2, 0), 0.035);
  g.add(t.mesh(LEVEL[c.level][1], 0.9));
  const l = label(`${m.est ? '~' : ''}${m.id}: ${c.text}`, LEVEL[c.level][0], 0.13); l.position.set(0, 1.6, 0); g.add(l);
  g.position.copy(m.pos); marksGroup.add(g); m.obj = g;
}
function refreshMarks() { if (design) marks.forEach(drawMark); }

// ---------- readout + results ----------
function placement() {   // where the layout sits relative to the two stakes
  if (state === 'preview' || state === 'center') return null;
  const mp = site.worldToLocal(worldOf(model, new THREE.Vector3()));
  const off = mp.clone().sub(stake1);
  const res = { height: off.y / FT, dist: Math.hypot(off.x, off.z) / FT };
  if (haveStake2) {
    const u = stake2.clone().sub(stake1); u.y = 0; const len = u.length(); u.normalize();
    const right = new THREE.Vector3(-u.z, 0, u.x);
    res.along = off.dot(u) / FT; res.right = off.dot(right) / FT; res.stakeDist = len / FT;
    const doorYaw = yawOf(model) + doorLocalYaw() - yawOf(site);
    let turn = ((doorYaw - Math.atan2(u.x, u.z)) * 180) / Math.PI;
    turn = ((turn + 540) % 360) - 180; res.turn = -turn;   // + = clockwise seen from above
    res.frame = (ptFt) => {   // model feet -> (along, right) from stake 1
      const w = worldOf(model, V(ptFt[0], ptFt[1])); const l = site.worldToLocal(w).sub(stake1);
      return [l.dot(u) / FT, l.dot(right) / FT];
    };
  }
  return res;
}
function updateReadout() {
  const el = $('readout'); if (!design) { el.textContent = ''; return; }
  if (state === 'preview') { el.innerHTML = `<b>${design.label}</b> · ${design.piers.length} piers · ${Math.round(design.area_sqft)} sq ft · drag to look around`; return; }
  const p = placement(); if (!p || p.along === undefined) { el.textContent = ''; return; }
  const worst = marks.filter((m) => m.info && m.info.level !== 'ok').length;
  const mv = p.dist < 0.04 ? 'on stake 1' : `${ftin(Math.abs(p.along))} ${p.along >= 0 ? 'toward' : 'away from'} stake 2, ${ftin(Math.abs(p.right))} ${p.right >= 0 ? 'right' : 'left'}`;
  el.innerHTML = `Centre: <b>${mv}</b>\nDoor turned <b>${Math.abs(p.turn).toFixed(1)}° ${p.turn >= 0 ? 'clockwise' : 'counter-clockwise'}</b> · height <b>${ftin(p.height)}</b>\n`
    + `Marks: <b>${marks.length}</b>${marks.length ? ` (${worst} in the way or within 3 ft)` : ''} · ground: ${hitKind === 'plane' ? 'tracked' : hitKind === 'level' ? 'estimated (level)' : 'searching…'}`;
}
function resultsText() {
  const p = placement(); const L = [];
  L.push(`${design.label}: ${design.piers.length} piers, ${Math.round(design.area_sqft)} sq ft`);
  { const h = deckInches(), d0 = Math.round(design.deck_top_ft * 12);
    L.push(`Deck height shown: ${h} in above the ground at stake 1${h !== d0 ? ` (design is ${d0} in; piers, steps and cost are NOT re-run for ${h} in)` : ''}${h > 30 ? '. Over 30 in: guards 36 in high and a stair handrail are required (IRC R312, R311.7.8).' : ''}`); }
  L.push(`Saved ${new Date().toLocaleString()}`);
  if (!p || p.along === undefined) { L.push('', 'Not placed yet.'); return L.join('\n'); }
  L.push('', 'DOME CENTRE (measure from stake 1, sighting toward stake 2)',
    `  stake 1 to stake 2: ${ftin(p.stakeDist)} as measured by the phone (check with a tape: this is the scale check)`,
    `  centre is ${ftin(Math.abs(p.along))} ${p.along >= 0 ? 'toward' : 'away from'} stake 2 and ${ftin(Math.abs(p.right))} to the ${p.right >= 0 ? 'right' : 'left'}`,
    `  door direction is ${Math.abs(p.turn).toFixed(1)} deg ${p.turn >= 0 ? 'clockwise' : 'counter-clockwise'} of the stake line (seen from above)`,
    `  layout raised ${ftin(p.height)} above the ground at stake 1`);
  L.push('', 'DECK CORNERS (from stake 1: along the stake line, then square off it)');
  design.outline.forEach((c, i) => { const [a, r] = p.frame(c);
    L.push(`  C${i + 1}: ${ftin(Math.abs(a))} ${a >= 0 ? 'toward stake 2' : 'behind stake 1'}, ${ftin(Math.abs(r))} ${r >= 0 ? 'right' : 'left'}`); });
  L.push('', `TREE MARKS (${marks.length})  x east / y north of the dome centre, in the layout's own frame`);
  if (!marks.length) L.push('  none');
  for (const m of marks) { const c = m.info || classify(m.pos); L.push(`  ${m.id}: x ${c.x.toFixed(1)}, y ${c.y.toFixed(1)} ft · ${c.text}${c.level === 'bad' ? '  << IN THE WAY' : ''}${m.est ? '  (ESTIMATED: level ground assumed, could be feet off)' : ''}`); }
  L.push('', 'Phone AR drifts: treat every number as +/- 6 in or worse. Tape and string for the real stake-out.');
  return L.join('\n');
}
function stakeAxes() { const u = stake2.clone().sub(stake1); u.y = 0; u.normalize(); return { u, right: new THREE.Vector3(-u.z, 0, u.x) }; }
function saveSnapshot() {
  if (state !== 'adjust' || !haveStake2) return;
  const p = placement(); if (!p || p.along === undefined) return;
  const { u, right } = stakeAxes();
  store.set('ccdome_ar_last', { when: new Date().toISOString(), text: resultsText() });
  store.set('ccdome_ar_state', { when: new Date().toISOString(), design: design.name, deckIn, along: p.along, right: p.right, turn: p.turn, height: p.height,
    marks: marks.map((m) => { const l = m.pos.clone().sub(stake1); return { id: m.id, a: l.dot(u) / FT, r: l.dot(right) / FT, h: l.y / FT, est: !!m.est }; }) });
  refreshLastButton();
}
// Rebuild the last saved layout + tree marks from the two (physical) stakes after a restart.
function restoreState() {
  const st = store.get('ccdome_ar_state', null); if (!st || !haveStake2) return;
  if (st.design !== design.name && DATA.designs.some((d) => d.name === st.design)) setDesign(st.design);
  if (st.deckIn !== undefined && st.deckIn !== deckIn) { deckIn = st.deckIn; store.set('ccdome_ar_deckin', deckIn); rebuild(); }
  const { u, right } = stakeAxes();
  const at = (a, r, h) => stake1.clone().addScaledVector(u, a * FT).addScaledVector(right, r * FT).add(new THREE.Vector3(0, h * FT, 0));
  model.position.copy(at(st.along, st.right, st.height));
  model.rotation.set(0, Math.atan2(u.x, u.z) - doorLocalYaw() - (st.turn * Math.PI) / 180, 0);
  while (marks.length) { const m = marks.pop(); marksGroup.remove(m.obj); dispose(m.obj); }
  markSeq = 0;
  for (const k of st.marks || []) { const m = { id: k.id, pos: at(k.a, k.r, k.h), est: !!k.est }; marks.push(m); drawMark(m); markSeq = Math.max(markSeq, parseInt(String(k.id).slice(1), 10) || 0); }
  show('btnRestore', false); updateReadout(); setStatus(`Restored the last layout and ${marks.length} tree marks`, 'Check a mark against its real tree. If it is off, use Fix drift in the menu.');
}
function refreshLastButton() {
  const last = store.get('ccdome_ar_last', null); let b = $('btnLast');
  if (!last || !last.text) return;
  if (!b) { b = document.createElement('button'); b.id = 'btnLast'; b.style.width = '100%'; b.style.marginTop = '6px';
    b.addEventListener('click', () => { const cur = store.get('ccdome_ar_last', null); $('resultsText').textContent = cur ? cur.text : ''; openSheet('results'); });
    $('intro').insertBefore(b, $('support')); }
  b.textContent = `Show last saved results (${new Date(last.when).toLocaleString()})`;
}

// ---------- actions ----------
function reticlePoint() { return reticle.visible ? reticle.position.clone() : null; }

function placeAction() {
  if (repinMode) {
    if (repin(repinMode)) { endRepin('Re-pinned'); saveSnapshot(); }
    else setStatus('No tracked ground under the ring', 'Aim at the stake and wait for a green ring.');
    return;
  }
  const pt = reticlePoint(); if (!pt) { setStatus('No ground found yet', 'Keep sweeping the phone slowly over textured ground.'); return; }
  if (state === 'center') {
    anchorGroup.position.set(0, 0, 0); anchorGroup.quaternion.identity();
    site.position.copy(pt); site.quaternion.identity(); model.position.set(0, 0, 0); model.rotation.set(0, 0, 0);
    stake1.set(0, 0, 0); haveStake2 = false; redrawStakes(); tryAnchor();
    setState('door');
  } else if (state === 'door') {
    const c = worldOf(site, stake1); if (Math.hypot(pt.x - c.x, pt.z - c.z) < 1.0) { setStatus('Too close to the centre', 'Aim at a spot at least 5 ft from the centre stake.'); return; }
    aimDoorAt(pt); stake2.copy(site.worldToLocal(pt.clone())); haveStake2 = true; redrawStakes();
    setState('adjust');
    const st = store.get('ccdome_ar_state', null);
    if (st) { $('btnRestore').textContent = `Restore last layout + ${(st.marks || []).length} tree marks (${new Date(st.when).toLocaleDateString()})`; show('btnRestore', true); }
  }
}
function aimDoorAt(worldPt) {
  const c = worldOf(site, stake1); const d = new THREE.Vector3(worldPt.x - c.x, 0, worldPt.z - c.z);
  if (d.lengthSq() < 0.25) return;
  const yaw = Math.atan2(d.x, d.z) - doorLocalYaw();
  editWorld(model, (o) => { o.rotation.set(0, yaw, 0); });
}
function tryAnchor() {
  anchor = null; anchorLive = false;
  if (lastHit && typeof lastHit.createAnchor === 'function') {
    lastHit.createAnchor().then((a) => { if (session) anchor = a; }).catch(() => { /* anchors optional */ });
  }
}
function nudge(act) {
  const s = STEPS[stepIx];
  const f = new THREE.Vector3(camDir.x, 0, camDir.z); if (f.lengthSq() < 1e-6) f.set(0, 0, -1); f.normalize();
  const r = new THREE.Vector3(-f.z, 0, f.x); const d = s.ft * FT;
  editWorld(model, (o) => {
    if (act === 'fwd') o.position.addScaledVector(f, d);
    if (act === 'back') o.position.addScaledVector(f, -d);
    if (act === 'right') o.position.addScaledVector(r, d);
    if (act === 'left') o.position.addScaledVector(r, -d);
    if (act === 'up') o.position.y += d;
    if (act === 'down') o.position.y -= d;
    if (act === 'rotL') o.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), (s.deg * Math.PI) / 180);
    if (act === 'rotR') o.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), (-s.deg * Math.PI) / 180);
  });
  refreshMarks(); updateReadout(); saveSnapshot(); show('btnRestore', false);
}
function markTree() {
  const pt = reticlePoint(); if (!pt) { setStatus('No ground under the ring', 'Aim at the base of the trunk.'); return; }
  const est = hitKind === 'level';
  if (est) {   // level-ground guess: only trust it when aiming steeply down (close to the trunk)
    const range = Math.hypot(pt.x - camPos.x, pt.z - camPos.z), camH = Math.max(0.3, camPos.y - pt.y);
    if (range / camH > 3) { setStatus('Ground not tracked there', 'Walk closer to the trunk and aim down at its base until the ring turns green.'); return; }
  }
  const m = { id: `T${++markSeq}`, pos: site.worldToLocal(pt.clone()), est };
  marks.push(m); drawMark(m); updateReadout(); saveSnapshot(); show('btnRestore', false);
  setStatus(`${m.id}: ${m.info.text}${est ? ' (estimated)' : ''}`, est ? 'Yellow ring = ground guessed as level. Re-mark from closer if this one matters.' : 'Aim at the base of the next trunk, on the side nearest the deck.');
}
function undoMark() {
  const m = marks.pop(); if (!m) return; marksGroup.remove(m.obj); dispose(m.obj); markSeq = Math.max(0, markSeq - 1);
  updateReadout(); saveSnapshot();
}
// Drift fixes: move the whole site (layout + marks + stakes) so a stake marker sits on the real stake again.
let repinMode = 0;
function armRepin(which) {
  openSheet(null);
  if (which === 2 && !haveStake2) { setStatus('No door stake set yet'); return; }
  repinMode = which; show('adjust', false); show('place', true);
  $('btnPlace').textContent = which === 1 ? 'Re-pin centre stake here' : 'Re-pin door stake here'; $('btnBack').textContent = 'Cancel';
  setStatus(`Aim the ring at the real ${which === 1 ? 'centre' : 'door'} stake`, 'Wait for a green ring, then tap. The layout and all tree marks move together.');
}
function endRepin(msg) { repinMode = 0; $('btnBack').textContent = 'Start over'; setState('adjust'); if (msg) setStatus(msg); }
function repin(which) {
  const pt = reticlePoint(); if (!pt) return false;
  if (which === 2 && hitKind !== 'plane') return false;
  if (which === 1) {
    const cur = worldOf(site, stake1); const delta = pt.clone().sub(cur);
    editWorld(site, (o) => o.position.add(delta));
  } else {
    if (!haveStake2) return false;
    const c = worldOf(site, stake1), cur = worldOf(site, stake2);
    const a0 = Math.atan2(cur.x - c.x, cur.z - c.z), a1 = Math.atan2(pt.x - c.x, pt.z - c.z);
    editWorld(site, (o) => {
      o.position.sub(c).applyAxisAngle(new THREE.Vector3(0, 1, 0), a1 - a0).add(c);
      o.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), a1 - a0);
    });
  }
  updateReadout(); return true;
}
function startOver() {
  while (marks.length) { const m = marks.pop(); marksGroup.remove(m.obj); dispose(m.obj); }
  markSeq = 0; haveStake2 = false; anchor = null; anchorLive = false; repinMode = 0; $('btnBack').textContent = 'Start over'; show('btnRestore', false);
  anchorGroup.position.set(0, 0, 0); anchorGroup.quaternion.identity();
  setState(session ? 'center' : 'preview');
}

// ---------- AR session ----------
async function startAR() {
  let s = null;
  try {
    s = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'dom-overlay'], optionalFeatures: ['anchors'], domOverlay: { root: $('overlay') },
    });
    s.addEventListener('end', onSessionEnd);
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(s);
    session = s; scene.background = null; previewGrid.visible = false;
    viewerSpace = await s.requestReferenceSpace('viewer');
    hitSource = await s.requestHitTestSource({ space: viewerSpace });
    startOver();
  } catch (e) {
    const msg = `Could not start AR: ${e && e.message ? e.message : e}`;
    if (s) { try { await s.end(); } catch { /* already ended */ } }
    $('support').textContent = msg;
  }
}
function onSessionEnd() {
  if (marks.length || !store.get('ccdome_ar_state', null)) saveSnapshot();
  repinMode = 0; $('btnBack').textContent = 'Start over'; show('btnRestore', false); openSheet(null); setUiHidden(false);
  session = null; hitSource = null; viewerSpace = null; refSpace = null; anchor = null; lastHit = null; hitKind = 'none';
  reticle.visible = false; scene.background = PREVIEW_BG; previewGrid.visible = true;
  // back to the desktop-style preview with the layout at the origin
  anchorGroup.position.set(0, 0, 0); anchorGroup.quaternion.identity(); site.position.set(0, 0, 0); site.quaternion.identity();
  model.position.set(0, 0, 0); model.rotation.set(0, 0, 0);
  while (marks.length) { const m = marks.pop(); marksGroup.remove(m.obj); dispose(m.obj); }
  markSeq = 0; haveStake2 = false; setState('preview'); resize();
}

function xrFrame(frame) {
  refSpace = renderer.xr.getReferenceSpace(); if (!refSpace) return;
  const vp = frame.getViewerPose(refSpace);
  if (vp) {
    const t = vp.transform; camPos.set(t.position.x, t.position.y, t.position.z);
    camDir.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w));
  }
  // tracking corrections: keep the site glued to the anchor
  if (anchor && frame.trackedAnchors && frame.trackedAnchors.has(anchor)) {
    const ap = frame.getPose(anchor.anchorSpace, refSpace);
    if (ap) {
      const setPose = (o) => { o.position.set(ap.transform.position.x, ap.transform.position.y, ap.transform.position.z);
        o.quaternion.set(ap.transform.orientation.x, ap.transform.orientation.y, ap.transform.orientation.z, ap.transform.orientation.w); };
      if (!anchorLive) { scene.attach(site); setPose(anchorGroup); anchorGroup.updateMatrixWorld(true); anchorGroup.attach(site); anchorLive = true; }
      else setPose(anchorGroup);
    }
  }
  // reticle: a real hit test if there is one, else the layout's own ground level (lets you mark far trees)
  let got = false; lastHit = null;
  if (hitSource) {
    const hits = frame.getHitTestResults(hitSource);
    if (hits.length) {
      const pose = hits[0].getPose(refSpace);
      if (pose) { reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z); lastHit = hits[0]; got = true; hitKind = 'plane'; }
    }
  }
  if (!got && vp && state !== 'center') {
    const gy = worldOf(site, stake1).y;
    if (camDir.y < -0.05 && camPos.y > gy) {
      const k = (gy - camPos.y) / camDir.y;
      if (k > 0 && k < 40) { reticle.position.copy(camPos).addScaledVector(camDir, k); got = true; hitKind = 'level'; }
    }
  }
  if (!got) hitKind = 'none';
  reticle.visible = got && !uiHidden; retMat.color.set(hitKind === 'level' ? 0xffd23f : 0x3ddc84);
  if (state === 'door' && got) aimDoorAt(reticle.position);
}

// ---------- preview camera (no AR): drag to orbit, pinch / wheel to zoom ----------
const orbit = { az: 0.6, el: 0.42, dist: 20, drag: null, pinch: 0 };
function placePreviewCamera() {
  const t = new THREE.Vector3(0, 1.5, 0);
  camera.position.set(t.x + orbit.dist * Math.cos(orbit.el) * Math.sin(orbit.az), t.y + orbit.dist * Math.sin(orbit.el), t.z + orbit.dist * Math.cos(orbit.el) * Math.cos(orbit.az));
  camera.lookAt(t);
}
const pts = new Map();
canvas.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, [e.clientX, e.clientY]); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || session) return;
  const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
  if (pts.size === 1) { orbit.az -= (e.clientX - prev[0]) * 0.006; orbit.el = Math.max(0.05, Math.min(1.5, orbit.el + (e.clientY - prev[1]) * 0.005)); }
  else if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (orbit.pinch) orbit.dist = Math.max(4, Math.min(80, (orbit.dist * orbit.pinch) / d)); orbit.pinch = d; }
});
const endPt = (e) => { pts.delete(e.pointerId); orbit.pinch = 0; };
canvas.addEventListener('pointerup', endPt); canvas.addEventListener('pointercancel', endPt);
canvas.addEventListener('wheel', (e) => { orbit.dist = Math.max(4, Math.min(80, orbit.dist * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: true });

function resize() {
  if (renderer.xr.isPresenting) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

let lastReadout = 0;
renderer.setAnimationLoop((time, frame) => {
  if (frame && session) { xrFrame(frame); if (time - lastReadout > 500) { lastReadout = time; updateReadout(); } }
  else placePreviewCamera();
  renderer.render(scene, camera);
});

// ---------- UI wiring ----------
function setUiHidden(on) {
  uiHidden = on; document.body.classList.toggle('clean', on);
  const live = state !== 'preview' && state !== 'center';
  marksGroup.visible = stakesGroup.visible = live && !on; if (on) reticle.visible = false;
  if (on) { const h = $('tapback').firstElementChild; h.style.animation = 'none'; void h.offsetWidth; h.style.animation = ''; }
}
document.querySelectorAll('.jsShade').forEach((b) => b.addEventListener('click', () => { shaded = !shaded; store.set('ccdome_ar_shaded', shaded); applyLayers(); }));
document.querySelectorAll('.jsHide').forEach((b) => b.addEventListener('click', () => { openSheet(null); setUiHidden(true); }));
$('tapback').addEventListener('click', () => setUiHidden(false));
document.querySelectorAll('.jsDeckDn').forEach((b) => b.addEventListener('click', () => setDeckIn(deckInches() - 3)));
document.querySelectorAll('.jsDeckUp').forEach((b) => b.addEventListener('click', () => setDeckIn(deckInches() + 3)));
document.querySelectorAll('.jsDeckH').forEach((b) => b.addEventListener('click', () => setDeckIn(null)));
function openSheet(which) { show('sheet', !!which); show('sheetMore', which === 'more'); show('sheetResults', which === 'results'); }
$('btnStart').addEventListener('click', startAR);
$('btnPlace').addEventListener('click', placeAction);
$('btnBack').addEventListener('click', () => { if (repinMode) endRepin('Re-pin cancelled'); else startOver(); });
let exitArmed = 0;
for (const id of ['btnExit1', 'btnExit2']) $(id).addEventListener('click', () => {
  if (marks.length && Date.now() - exitArmed > 4000) { exitArmed = Date.now(); $(id).textContent = `Tap again to exit (${marks.length} marks are saved)`; setTimeout(() => { $(id).textContent = 'Exit AR'; }, 4000); return; }
  openSheet(null); if (session) session.end();
});
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => nudge(b.dataset.act)));
$('btnStep').addEventListener('click', () => { stepIx = (stepIx + 1) % STEPS.length; $('btnStep').firstChild.textContent = STEPS[stepIx].name; });
$('btnMark').addEventListener('click', markTree);
$('btnUndo').addEventListener('click', undoMark);
$('btnRestore').addEventListener('click', restoreState);
$('btnMore').addEventListener('click', () => openSheet('more'));
$('btnCloseMore').addEventListener('click', () => openSheet(null));
$('btnResults').addEventListener('click', () => { $('resultsText').textContent = resultsText(); saveSnapshot(); openSheet('results'); });
$('btnCloseResults').addEventListener('click', () => openSheet(null));
$('btnCopy').addEventListener('click', async () => {
  const text = $('resultsText').textContent;
  try { await navigator.clipboard.writeText(text); $('btnCopy').textContent = 'Copied'; }
  catch { const r = document.createRange(); r.selectNodeContents($('resultsText')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $('btnCopy').textContent = 'Selected: long-press to copy'; }
  setTimeout(() => { $('btnCopy').textContent = 'Copy text'; }, 2500);
});
$('btnRestart').addEventListener('click', () => { openSheet(null); startOver(); });
$('btnRepin1').addEventListener('click', () => armRepin(1));
$('btnRepin2').addEventListener('click', () => armRepin(2));
document.querySelectorAll('[data-layer]').forEach((c) => c.addEventListener('change', () => { layerOn[c.dataset.layer] = c.checked; store.set('ccdome_ar_layers', layerOn); applyLayers(); }));
for (const id of ['design', 'design2']) $(id).addEventListener('change', (e) => setDesign(e.target.value));

// ---------- boot ----------
async function boot() {
  scene.background = PREVIEW_BG; resize();
  try { DATA = await (await fetch('layout.json')).json(); }
  catch (e) { setStatus('Could not load layout.json', String(e)); return; }
  for (const id of ['design', 'design2']) $(id).innerHTML = DATA.designs.map((d) => `<option value="${d.name}">${d.label}</option>`).join('');
  setDesign(store.get('ccdome_ar_design', DATA.designs[0].name));
  $('ver').textContent = `layout ${DATA.generated}`;
  setState('preview'); setStatus('Dome site layout', 'Preview. Start AR on site to see it full size.');
  let ok = false, why = '';
  if (!window.isSecureContext) why = 'This page must be opened over https (or localhost) for AR to work.';
  else if (!navigator.xr) why = 'This browser has no WebXR. Use Chrome on the Pixel.';
  else { try { ok = await navigator.xr.isSessionSupported('immersive-ar'); } catch { ok = false; } if (!ok) why = 'AR is not available here. On the Pixel, use Chrome and check that "Google Play Services for AR" is installed.'; }
  $('btnStart').disabled = !ok; $('support').textContent = why;
  refreshLastButton();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    const base = $('ver').textContent; $('ver').textContent = `${base} · NOT saved for offline yet`;
    const SHELL = ['./', './index.html', './app.js', './layout.json', './vendor/three.module.min.js'];
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)
      .then(async () => { for (let i = 0; i < 20; i++) { const hits = await Promise.all(SHELL.map((u) => caches.match(u)));
        if (hits.every(Boolean)) { $('ver').textContent = `${base} · offline ready`; return; } await new Promise((r) => setTimeout(r, 500)); } })
      .catch((e) => { $('ver').textContent = `${base} · offline cache failed: ${e}`; });
  }
}
boot();

// test hook for the desktop preview
window.__ccdome = { scene, model, site, marks, setDesign, classify, toModelFt, placement, resultsText, THREE,
  _sim: { get state() { return state; }, setState, restoreState, saveSnapshot, startOver, stake1, stake2, setStake2(v) { stake2.copy(v); haveStake2 = true; redrawStakes(); }, aimDoorAt, nudge, repin, reticle, camDir,
          addMark(worldV) { const m = { id: `T${++markSeq}`, pos: site.worldToLocal(worldV.clone()) }; marks.push(m); drawMark(m); return m; } } };
