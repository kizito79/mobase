import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Viewer3D } from './viewer3d.js';
import { Map2D } from './map2d.js';
import { CLASS_NAMES, classHex, RAMP_CSS, RETURN_NAMES, RETURN_RGB } from './ramps.js';

const $ = (id) => document.getElementById(id);
const nf = (v, d = 0) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

const viewer = new Viewer3D($('view3d'));
window.lidarViewer = viewer; // handy for debugging from the browser console
const compass = $('compass');
viewer.onFrame = (heading) => { compass.style.transform = `rotate(${-heading}deg)`; };
$('year').textContent = new Date().getFullYear();
if (window.LIDAR_SHARED) $('shot').hidden = true; // downloads are blocked on hosted share pages
const logoImg = new Image();
logoImg.src = 'assets/citibim-logo-white.png';
let map = null;
let meta = null, base = '', grids = {}, orthoTex = null;
let classOn = new Array(32).fill(true);
let profileM = null;

// ------------------------------------------------------------------ loading
// A data file may be split into parts (meta.parts[name] = [part names]) for hosts with file-size limits.
async function fetchData(name, Type, onBytes) {
  const parts = meta.parts?.[name];
  if (!parts) return fetchBin(`${base}/${name}`, Type, onBytes);
  const arrs = await Promise.all(parts.map((p) => fetchBin(`${base}/${p}`, Uint8Array, onBytes)));
  const all = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { all.set(a, o); o += a.length; }
  return new Type(all.buffer, 0, all.byteLength / Type.BYTES_PER_ELEMENT);
}

async function fetchBase64(url, Type, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const txt = (await res.text()).trim();
  let bytes;
  if (Uint8Array.fromBase64) bytes = Uint8Array.fromBase64(txt);
  else {
    const s = atob(txt);
    bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  }
  onBytes(bytes.length);
  return new Type(bytes.buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

async function fetchBin(url, Type, onBytes) {
  if (url.endsWith('.b64.txt')) return fetchBase64(url, Type, onBytes);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const reader = res.body.getReader();
  const len = +res.headers.get('content-length') || 0;
  const out = len ? new Uint8Array(len) : null;
  const chunks = [];
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (out) out.set(value, off); else chunks.push(value);
    off += value.length;
    onBytes(value.length);
  }
  let bytes = out;
  if (!bytes) { bytes = new Uint8Array(off); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; } }
  return new Type(bytes.buffer, 0, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

function setLoading(text, frac) {
  $('loader').hidden = frac === null;
  if (text) $('ltext').textContent = text;
  if (frac != null) $('lbar').style.width = `${Math.round(frac * 100)}%`;
}

async function loadProject(id) {
  setLoading('Loading project…', 0);
  base = `data/${id}`;
  meta = await (await fetch(`${base}/meta.json`)).json();
  const files = meta.points.files;
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  let got = 0;
  const tick = (n) => { got += n; setLoading(`Loading ${nf(meta.points.count)} points… ${nf(got / 1048576, 0)} / ${nf(total / 1048576, 0)} MB`, got / total); };
  const [pos, rgb, int, cls, ret] = await Promise.all([
    fetchData('pos.f32', Float32Array, tick),
    fetchData('rgb.u8', Uint8Array, tick),
    fetchData('int.u16', Uint16Array, tick),
    fetchData('cls.u8', Uint8Array, tick),
    fetchData('ret.u8', Uint8Array, tick),
  ]);
  setLoading('Loading elevation grids…', 1);
  grids = {};
  await Promise.all(['dsm', 'dem', 'ndsm'].filter((k) => meta.rasters[k]).map(async (k) => {
    const r = meta.rasters[k];
    grids[k] = { ...r, data: await fetchData(`${k}.f32`, Float32Array, () => {}) };
  }));
  orthoTex = null;
  if (meta.rasters.dom) {
    const tex = await new THREE.TextureLoader().loadAsync(`${base}/${meta.rasters.dom.file}`);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    orthoTex = { tex, bounds: meta.rasters.dom.bounds_lonlat };
  }

  photoTex?.tex.dispose();
  photoTex = null;
  buildSurfaceOptions();

  viewer.setData(meta, { pos, rgb, int, cls, ret, count: meta.points.count });
  viewer.setModel(null);
  modelState = null;
  setupModelUI();
  setupAoi();
  classOn = new Array(32).fill(true);
  $('surface').value = 'none';
  $('showPoints').checked = true;
  $('profile').hidden = true;
  buildClassList();
  setupClip();
  setupRamp();
  applyMode();
  renderStats();
  if (map) map.setProject(meta, base, grids, toLocal);
  setLoading(null, null);
}

// ------------------------------------------------------------------ textured model (.glb, added with add_model.py)
// Loaded on demand: the first tick of "show" downloads it; it is placed by the offset stored in meta.model.
let modelState = null; // null | 'loading' | 'ready'
const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);

function setupModelUI() {
  const m = meta.model;
  $('modelBox').hidden = !m;
  $('showModel').checked = false;
  $('modelOpacity').value = 1;
  if (!m) return;
  $('modelName').textContent = m.name || 'Textured model';
  $('modelInfo').textContent = `${nf(m.triangles)} triangles · ${m.textures} textures · ${nf(m.bytes / 1048576, 0)} MB, loads when ticked`;
}

async function loadModel() {
  const m = meta.model, forProject = meta.id;
  modelState = 'loading';
  let got = 0;
  try {
    const bytes = await fetchData(m.file, Uint8Array, (n) => {
      got += n;
      setLoading(`Loading textured model… ${nf(got / 1048576, 0)} / ${nf(m.bytes / 1048576, 0)} MB`, got / m.bytes);
    });
    setLoading('Decoding textured model…', 1);
    const gltf = await gltfLoader.parseAsync(bytes.buffer, '');
    if (meta.id !== forProject) return; // project switched while loading
    const root = gltf.scene;
    root.position.set(...m.offset);
    root.traverse((o) => { if (o.material?.map) o.material.map.anisotropy = 8; });
    viewer.setModel(root);
    viewer.setModelOpacity(+$('modelOpacity').value);
    viewer.setModelVisible($('showModel').checked);
    modelState = 'ready';
    $('modelInfo').textContent = `${nf(m.triangles)} triangles · ${m.textures} textures`;
  } catch (err) {
    console.error(err);
    modelState = null;
    $('showModel').checked = false;
    $('modelInfo').textContent = `Could not load the model: ${err.message}`;
  } finally {
    setLoading(null, null);
  }
}

$('showModel').addEventListener('change', () => {
  if ($('showModel').checked && !modelState) loadModel();
  else viewer.setModelVisible($('showModel').checked);
});
$('modelOpacity').addEventListener('input', () => viewer.setModelOpacity(+$('modelOpacity').value));

// ------------------------------------------------------------------ area of interest (added with add_aoi.py)
function gridZ(key, x, y) {
  const g = grids[key], ll = toLonLat(x, y);
  if (!g || !ll) return NaN;
  const [w, s, e, n] = g.bounds_lonlat;
  const c = Math.floor(((ll[0] - w) / (e - w)) * g.width), r = Math.floor(((n - ll[1]) / (n - s)) * g.height);
  return c < 0 || r < 0 || c >= g.width || r >= g.height ? NaN : g.data[r * g.width + c];
}

function setupAoi() {
  const a = meta.aoi;
  $('aoiBox').hidden = !a;
  $('showAoi').checked = true;
  $('aoiOnly').checked = !!a?.buffer; // a buffered AOI clips by default
  map?.setClip($('aoiOnly').checked);
  if (!a) return;
  $('aoiOnlyLbl').textContent = a.buffer ? `Clip to boundary + ${nf(a.buffer.distance_m, 0)} m buffer` : 'Clip to boundary';
  const [E0, N0] = meta.points.origin;
  const local = (rs) => rs.map((r) => r.map(([e, n]) => [e - E0, n - N0]));
  // drape on the DSM (tops of roofs/trees), falling back to the DEM
  const zAt = (x, y) => { const z = gridZ('dsm', x, y); return Number.isFinite(z) ? z : gridZ('dem', x, y); };
  viewer.setAoi(local(a.rings_work), zAt, `${a.name}<br><small>${nf(a.area_m2 / 10000, 2)} ha</small>`,
    a.buffer ? local(a.buffer.rings_work) : null);
  if ($('aoiOnly').checked) {
    aoiInfo(viewer.computeAoiMask());
    viewer.setAoiOnly(true);
    viewer.viewPreset('oblique', 'aoi');
  } else {
    aoiInfo();
    setTimeout(() => { if (meta.aoi === a) aoiInfo(viewer.computeAoiMask()); }, 50); // point count, off the load path
  }
}

function aoiInfo(count = viewer.aoiMask?.count) {
  const a = meta.aoi, b = a.buffer;
  const p = meta.points, thin = p.count < p.count_total;
  const full = count != null ? Math.round(count * p.count_total / p.count) : null; // scale up if the browser copy is thinned
  const zone = b ? 'in the buffered area' : 'inside', zArea = b ? b.area_m2 : a.area_m2;
  $('aoiInfo').innerHTML = `<b>${a.name}</b><br>${nf(a.area_m2, 0)} m² (${nf(a.area_m2 / 10000, 3)} ha) · perimeter ${nf(a.perimeter_m, 1)} m`
    + (b ? `<br>With ${nf(b.distance_m, 0)} m buffer: ${nf(b.area_m2, 0)} m² (${nf(b.area_m2 / 10000, 3)} ha) · perimeter ${nf(b.perimeter_m, 1)} m` : '')
    + (count == null ? '' : thin
      ? `<br>≈${nf(full)} LiDAR points ${zone} (≈${nf(full / zArea, 0)} /m²; ${nf(count)} shown)`
      : `<br>${nf(count)} LiDAR points ${zone} (${nf(count / zArea, 0)} /m²)`);
}

$('showAoi').addEventListener('change', () => {
  viewer.setAoiVisible($('showAoi').checked);
  map?.setAoiVisible($('showAoi').checked);
});
$('aoiOnly').addEventListener('change', () => {
  viewer.setAoiOnly($('aoiOnly').checked);
  map?.setClip($('aoiOnly').checked);
  aoiInfo();
  refreshProfile();
});
$('aoiZoom').addEventListener('click', () => viewer.viewPreset('oblique', 'aoi'));

// ------------------------------------------------------------------ coordinates
function toLonLat(x, y) {
  const a = meta.points.affine?.local_to_lonlat;
  if (!a) return null;
  return [a[0][0] * x + a[0][1] * y + a[0][2], a[1][0] * x + a[1][1] * y + a[1][2]];
}
function toLocal(lon, lat) {
  const a = meta.points.affine.lonlat_to_local;
  return [a[0][0] * lon + a[0][1] * lat + a[0][2], a[1][0] * lon + a[1][1] * lat + a[1][2]];
}

// ------------------------------------------------------------------ sidebar
function buildClassList() {
  const box = $('classes');
  box.innerHTML = '';
  const mode = $('mode').value;
  for (const [c, n] of Object.entries(meta.points.classes)) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" ${classOn[c] ? 'checked' : ''}>
      <span class="sw" style="background:${classHex(+c)}"></span>
      <span>${CLASS_NAMES[c] || `Class ${c}`}</span><span class="n">${nf(n)}</span>`;
    l.querySelector('input').addEventListener('change', (e) => {
      classOn[c] = e.target.checked;
      viewer.set('classMask', classOn);
      refreshProfile();
    });
    box.appendChild(l);
  }
  void mode;
}

function setupClip() {
  const [, , zmin, , , zmax] = meta.points.bounds_local;
  const Z0 = meta.points.origin[2];
  for (const id of ['clipLo', 'clipHi']) {
    $(id).min = (zmin + Z0).toFixed(1);
    $(id).max = (zmax + Z0).toFixed(1);
  }
  $('clipLo').value = $('clipLo').min;
  $('clipHi').value = $('clipHi').max;
  updateClip();
}

function updateClip() {
  const Z0 = meta.points.origin[2];
  let lo = +$('clipLo').value, hi = +$('clipHi').value;
  if (lo > hi) [lo, hi] = [hi, lo];
  $('clipOut').textContent = `${lo.toFixed(1)} – ${hi.toFixed(1)} m`;
  const full = lo <= +$('clipLo').min && hi >= +$('clipHi').max;
  viewer.set('clip', full ? [-1e9, 1e9] : [lo - Z0, hi - Z0]);
  refreshProfileDebounced();
}

function setupRamp() {
  const Z0 = meta.points.origin[2];
  const [a, b] = meta.points.z_default;
  $('zmin').value = (a + Z0).toFixed(1);
  $('zmax').value = (b + Z0).toFixed(1);
  updateRamp();
}

function updateRamp() {
  const Z0 = meta.points.origin[2];
  const a = +$('zmin').value, b = +$('zmax').value;
  viewer.set('zRange', [a - Z0, b - Z0]);
  $('rampLegend').innerHTML = `<div class="bar" style="background:${RAMP_CSS}"></div>
    <div class="ticks"><span>${a.toFixed(1)} m</span><span>${((a + b) / 2).toFixed(1)}</span><span>${b.toFixed(1)} m</span></div>`;
  refreshProfileDebounced();
}

function applyMode() {
  const m = $('mode').value;
  viewer.set('mode', m);
  $('zrangeBox').hidden = m !== 'elevation';
  $('rampLegend').hidden = m !== 'elevation';
  if (m === 'returns') {
    $('rampLegend').hidden = false;
    $('rampLegend').innerHTML = RETURN_NAMES.map((n, i) =>
      `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:10px"><span class="sw" style="width:10px;height:10px;border-radius:3px;background:rgb(${RETURN_RGB[i].map((v) => v * 255).join(',')})"></span>${n}</span>`).join('');
  } else if (m === 'elevation') updateRamp();
  refreshProfile();
}

function renderStats() {
  const p = meta.points;
  const Z0 = p.origin[2];
  const b = p.bounds_local;
  const rows = [
    ['Points', nf(p.count_total) + (p.count < p.count_total ? ` (showing ${nf(p.count)})` : '')],
    ['Covered area', `${nf(p.area_m2)} m² (${nf(p.area_m2 / 10000, 2)} ha)`],
    ['Density', `${nf(p.density, 1)} pts/m²`],
    ['Avg spacing', `${nf(p.spacing * 100, 1)} cm`],
    ['Extent', `${nf(b[3] - b[0], 1)} × ${nf(b[4] - b[1], 1)} m`],
    ['Elevation', `${nf(b[2] + Z0, 2)} – ${nf(b[5] + Z0, 2)} m`],
    ['Relief', `${nf(b[5] - b[2], 2)} m`],
    ['Multi-returns', `${nf(100 * (1 - (p.returns[1] || 0) / p.count_total), 1)}%`],
    ['Captured', p.captured || '—'],
    ['Source CRS', p.crs_source || 'none'],
    ['Working CRS', p.crs_work || '—'],
    ['Origin E/N', `${nf(p.origin[0])}, ${nf(p.origin[1])}`],
  ];
  if (meta.rasters.dsm) rows.push(['DSM grid', `${meta.rasters.dsm.full_size.join(' × ')} px @ ${nf(meta.rasters.dsm.pixel_m[0] * meta.rasters.dsm.width / meta.rasters.dsm.full_size[0] * 100, 1)} cm`]);
  if (meta.rasters.dem) rows.push(['DEM grid', `${meta.rasters.dem.full_size.join(' × ')} px @ ${nf(meta.rasters.dem.pixel_m[0] * meta.rasters.dem.width / meta.rasters.dem.full_size[0] * 100, 0)} cm`]);
  if (meta.rasters.photo?.full_size) {
    const ph = meta.rasters.photo;
    rows.push(['Orthophoto', `${ph.full_size.join(' × ')} px @ ${nf(ph.gsd_m[0] * 100, 1)} cm (viewer: ${ph.width} × ${ph.height})`]);
  }
  rows.push(['Prepared', meta.prepared]);
  const pts = p.count_total >= 1e6 ? [nf(p.count_total / 1e6, 1), 'M'] : [nf(p.count_total / 1e3, 0), 'k'];
  $('kpis').innerHTML = [
    [pts[0], pts[1], 'points'],
    [nf(p.area_m2 / 10000, 2), 'ha', 'covered'],
    [nf(p.density, 0), '/m²', 'density'],
  ].map(([v, u, k]) => `<div class="kpi"><div class="v">${v}<span class="u">${u}</span></div><div class="k">${k}</div></div>`).join('');
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ------------------------------------------------------------------ hover readout
viewer.addEventListener('hover', (e) => {
  const hit = e.detail;
  const box = $('readout');
  if (!hit || !meta) { box.hidden = true; return; }
  const p = hit.point, [E0, N0, Z0] = meta.points.origin;
  const ll = toLonLat(p.x, p.y);
  let extra = '';
  if (hit.index >= 0) {
    const i = hit.index, b = viewer.buf;
    extra = `<div><b>Class</b> ${CLASS_NAMES[b.cls[i]] || b.cls[i]} &nbsp; <b>Return</b> ${b.ret[i]} &nbsp; <b>Int</b> ${b.int[i] >> 8}</div>`;
  } else extra = `<div><b>${hit.source === 'model' ? 'Textured model' : 'Surface mesh'}</b></div>`;
  box.innerHTML = `
    <div><b>E</b> ${nf(p.x + E0, 2)} &nbsp; <b>N</b> ${nf(p.y + N0, 2)}</div>
    <div><b>Z</b> ${nf(p.z + Z0, 2)} m</div>
    ${ll ? `<div><b>Lat/Lon</b> ${ll[1].toFixed(7)}, ${ll[0].toFixed(7)}</div>` : ''}${extra}`;
  box.hidden = false;
});

// ------------------------------------------------------------------ measurements
const HINTS = {
  point: 'Click a point to pin its elevation',
  distance: 'Click to add points · Enter or double-click to finish · Backspace undoes · Esc cancels',
  height: 'Click the lower point, then the upper point',
  area: 'Click the corners · Enter or double-click to close the polygon',
  profile: 'Click the start (A) and end (B) of the cross-section',
};
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  viewer.setTool(viewer.tool === b.dataset.tool ? 'none' : b.dataset.tool);
}));
viewer.addEventListener('tool', (e) => {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === e.detail));
  $('hint').hidden = e.detail === 'none';
  $('hint').textContent = HINTS[e.detail] || '';
});
viewer.addEventListener('measures', (e) => {
  $('mlist').innerHTML = '';
  for (const m of e.detail) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${m.type === 'point' ? 'Point' : m.type}</span><span class="s">${m.summary || ''}</span><button title="Remove">✕</button>`;
    li.querySelector('button').addEventListener('click', () => viewer.removeMeasure(m.id));
    $('mlist').appendChild(li);
  }
});
$('clearM').addEventListener('click', () => viewer.clearMeasures());
$('pwidth').addEventListener('change', () => viewer.setProfileWidth(Math.max(0.1, +$('pwidth').value)));

// ------------------------------------------------------------------ profile chart
let prof = null;
viewer.addEventListener('profile', (e) => {
  // keep only the latest profile
  if (e.detail) for (const m of [...viewer.measures]) if (m.type === 'profile' && m !== e.detail) viewer.removeMeasure(m.id);
  profileM = e.detail;
  $('profile').hidden = !profileM;
  viewer.resize();
  if (map && meta.points.affine) {
    if (profileM) map.showProfile(toLonLat(profileM.pts[0].x, profileM.pts[0].y), toLonLat(profileM.pts[1].x, profileM.pts[1].y));
    else map.showProfile(null);
  }
  refreshProfile();
});
$('pClose').addEventListener('click', () => { if (profileM) viewer.removeMeasure(profileM.id); });
$('pEqual').addEventListener('change', () => drawProfile());
new ResizeObserver(() => drawProfile()).observe($('pcanvas'));

let profTimer = 0;
function refreshProfileDebounced() { clearTimeout(profTimer); profTimer = setTimeout(refreshProfile, 120); }
function refreshProfile() {
  if (!profileM) { prof = null; return; }
  prof = viewer.computeProfile(profileM);
  $('pinfo').textContent = `${nf(prof.length, 1)} m long · ${nf(viewer.profileWidth, 1)} m wide · ${nf(prof.t.length)} points`;
  drawProfile();
}

function niceStep(range, target) {
  const raw = range / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

function drawProfile() {
  const cv = $('pcanvas');
  if (!prof || $('profile').hidden) return;
  const dpr = devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#05182a'; g.fillRect(0, 0, W, H);
  const Z0 = meta.points.origin[2];
  const pad = { l: 56, r: 14, t: 10, b: 26 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  let zmin = Infinity, zmax = -Infinity;
  for (const z of prof.z) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
  if (!prof.z.length) { zmin = 0; zmax = 1; }
  const zr = Math.max(zmax - zmin, 0.5);
  zmin -= zr * 0.05; zmax += zr * 0.05;
  let sx = pw / prof.length, sy = ph / (zmax - zmin);
  if ($('pEqual').checked) {
    const s = Math.min(sx, sy); sx = sy = s;
    const mid = (zmin + zmax) / 2; zmin = mid - ph / s / 2; zmax = mid + ph / s / 2;
  }
  const X = (t) => pad.l + t * sx, Y = (z) => pad.t + ph - (z - zmin) * sy;
  prof.map = { X, Y, sx, sy, pad, zmin, Z0 };

  g.font = '11px "Instrument Sans", system-ui, sans-serif'; g.fillStyle = '#7f9bb0'; g.strokeStyle = '#123249'; g.lineWidth = 1;
  const zs = niceStep(zmax - zmin, 5);
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let z = Math.ceil((zmin + Z0) / zs) * zs; z <= zmax + Z0; z += zs) {
    const y = Math.round(Y(z - Z0)) + 0.5;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + pw, y); g.stroke();
    g.fillText(nf(z, zs < 1 ? 1 : 0), pad.l - 6, y);
  }
  const ts = niceStep(prof.length, 8);
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let t = 0; t <= prof.length + 1e-6; t += ts) {
    const x = Math.round(X(t)) + 0.5;
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + ph); g.stroke();
    g.fillText(`${nf(t, ts < 1 ? 1 : 0)} m`, x, pad.t + ph + 6);
  }
  g.fillText('A', pad.l, 0); g.textAlign = 'right'; g.fillText('B', pad.l + pw, 0);

  g.save();
  g.beginPath(); g.rect(pad.l, pad.t, pw, ph); g.clip();
  const c = [0, 0, 0];
  const size = Math.max(1.5, Math.min(3, 1.5 * dpr));
  for (let k = 0; k < prof.t.length; k++) {
    viewer.colorOf(prof.idx[k], c);
    g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    g.fillRect(X(prof.t[k]) - size / 2, Y(prof.z[k]) - size / 2, size, size);
  }
  g.restore();
}

$('pcanvas').addEventListener('mousemove', (e) => {
  const tip = $('ptip');
  if (!prof?.map) return;
  const r = $('pcanvas').getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const { pad, sx, sy, zmin, Z0 } = prof.map;
  const t = (x - pad.l) / sx, z = zmin + (r.height - pad.b - y) / sy;
  if (t < 0 || t > prof.length) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.textContent = `${nf(t, 2)} m · Z ${nf(z + Z0, 2)} m`;
  tip.style.left = `${x + 14}px`;
  tip.style.top = `${y + r.top - $('profile').getBoundingClientRect().top + 10}px`;
});
$('pcanvas').addEventListener('mouseleave', () => { $('ptip').hidden = true; });

// ------------------------------------------------------------------ controls
$('mode').addEventListener('change', applyMode);
$('zmin').addEventListener('change', updateRamp);
$('zmax').addEventListener('change', updateRamp);
$('clipLo').addEventListener('input', updateClip);
$('clipHi').addEventListener('input', updateClip);
const sizeUpdate = () => {
  viewer.set('size', +$('size').value);
  $('sizeOut').textContent = $('sizeMode').value === 'adaptive' ? `${nf(+$('size').value * 4, 0)} cm` : `${$('size').value} px`;
};
$('size').addEventListener('input', sizeUpdate);
$('sizeMode').addEventListener('change', () => { viewer.set('sizeMode', $('sizeMode').value); sizeUpdate(); });
$('round').addEventListener('change', () => viewer.set('round', $('round').checked));
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => viewer.viewPreset(b.dataset.preset)));
$('showPoints').addEventListener('change', () => viewer.setPointsVisible($('showPoints').checked));
// Surface options: DSM/DEM draped with the LiDAR orthomosaic, plus the extra orthophoto (add_ortho.py) when present.
let photoTex = null;
function buildSurfaceOptions() {
  const r = meta.rasters, opts = [['none', 'None']];
  const photo = r.photo ? (r.photo.name || 'Orthophoto').replace(/\s*\(.*\)$/, '') : null;
  for (const k of ['dsm', 'dem']) {
    if (!r[k]) continue;
    if (photo) opts.push([`${k}:photo`, `${k.toUpperCase()} + ${photo}`]);
    opts.push([k, `${k.toUpperCase()} + ${r.dom && photo ? 'LiDAR ortho' : 'ortho'}`]);
  }
  $('surface').innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
}

async function loadPhotoTex() {
  if (photoTex) return photoTex;
  const r = meta.rasters.photo, forProject = meta.id;
  setLoading(`Loading ${r.name || 'orthophoto'}…`, 0.5);
  try {
    const tex = await new THREE.TextureLoader().loadAsync(`${base}/${r.file}`);
    if (meta.id !== forProject) { tex.dispose(); return null; }
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    photoTex = { tex, bounds: r.bounds_lonlat };
    return photoTex;
  } finally {
    setLoading(null, null);
  }
}

$('surface').addEventListener('change', async () => {
  const v = $('surface').value;
  const [k, src] = v.split(':');
  const tex = src === 'photo' ? await loadPhotoTex() : orthoTex;
  if ($('surface').value !== v) return; // changed again while loading
  viewer.setSurface(k, grids[k], tex, +$('surfOpacity').value);
});
$('surfOpacity').addEventListener('input', () => viewer.setSurfaceOpacity(+$('surfOpacity').value));
$('mapOpacity').addEventListener('input', () => map?.setOpacity(+$('mapOpacity').value));
// Branded screenshot: gradient background + 3D view + labels-free overlay with logo, project and date
$('shot').addEventListener('click', async () => {
  const src = new Image();
  src.src = viewer.screenshot();
  await src.decode();
  const W = src.width, H = src.height, s = W / viewer.canvas.clientWidth;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, Math.max(W, H) * 0.7);
  grad.addColorStop(0, '#0b2a40'); grad.addColorStop(1, '#051521');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.drawImage(src, 0, 0);
  // footer band
  const bh = 46 * s;
  g.fillStyle = 'rgba(1, 59, 95, 0.88)';
  g.fillRect(0, H - bh, W, bh);
  g.fillStyle = '#1fb3c1'; g.fillRect(0, H - bh, W, 2 * s);
  const lh = 26 * s, lw = logoImg.width * lh / logoImg.height;
  g.drawImage(logoImg, 16 * s, H - bh + (bh - lh) / 2, lw, lh);
  g.fillStyle = '#e9f1f6';
  g.font = `600 ${14 * s}px "Instrument Sans", sans-serif`;
  g.textBaseline = 'middle';
  const x0 = 16 * s + lw + 18 * s;
  g.fillText(`${meta.name} · LiDAR point cloud`, x0, H - bh / 2 - 7 * s);
  g.fillStyle = '#9fb7c8';
  g.font = `${11.5 * s}px "Instrument Sans", sans-serif`;
  g.fillText(`${nf(meta.points.count_total)} points · ${meta.points.crs_work || ''} · ${new Date().toLocaleDateString()}`, x0, H - bh / 2 + 9 * s);
  g.textAlign = 'right';
  g.fillText('citibim.com', W - 16 * s, H - bh / 2);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `${meta?.id || 'lidar'}-3d-${Date.now()}.png`;
  a.click();
});
sizeUpdate();

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
  $('view3d').hidden = v !== '3d';
  $('view2d').hidden = v !== '2d';
  $('legend2d').hidden = true;
  $('readout').hidden = true;
  $('readout2d').hidden = v !== '2d';
  $('hint').hidden = v !== '3d' || viewer.tool === 'none';
  document.querySelectorAll('[data-for]').forEach((s) => (s.hidden = s.dataset.for !== v));
  if (v === '2d') {
    if (!map) {
      map = window.lidarMap = new Map2D($('view2d'), $('readout2d'), $('legend2d'));
      map.clipOn = $('aoiOnly').checked;
      if (meta) map.setProject(meta, base, grids, toLocal);
      if (profileM) map.showProfile(toLonLat(profileM.pts[0].x, profileM.pts[0].y), toLonLat(profileM.pts[1].x, profileM.pts[1].y));
    } else { map.invalidate(); map._legend(); }
    $('readout2d').innerHTML = '<div>Move the cursor over the map</div>';
  } else viewer.resize();
}));

// ------------------------------------------------------------------ boot
(async () => {
  try {
    const projects = await (await fetch('data/projects.json')).json();
    $('project').innerHTML = projects.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    $('project').addEventListener('change', () => loadProject($('project').value));
    const want = new URLSearchParams(location.search).get('project');
    const first = projects.find((p) => p.id === want) || projects[projects.length - 1];
    if (!first) throw new Error('No projects yet. Run prepare.py first.');
    $('project').value = first.id;
    await loadProject(first.id);
  } catch (err) {
    console.error(err);
    setLoading(`Could not load data: ${err.message}`, 0);
  }
})();
