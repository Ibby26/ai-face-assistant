// Realistic talking: the photo is wrapped on a fine triangle mesh built from
// the face's landmarks, and the mesh is moved like a real jaw, lips and eyelids.
// Every pixel is resampled smoothly by the GPU (WebGL), so there are no
// stretched strips or pasted shapes. Where the lips part, a soft mouth
// interior (shadow and teeth) shows through.

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// MediaPipe face landmark indices
const INNER_UP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const INNER_LOW = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
const EYES = [
  { up: [33, 246, 161, 160, 159, 158, 157, 173, 133], low: [33, 7, 163, 144, 145, 153, 154, 155, 133] },
  { up: [263, 466, 388, 387, 386, 385, 384, 398, 362], low: [263, 249, 390, 373, 374, 380, 381, 382, 362] },
];

// ------------------------------------------------------------------ geometry
function resample(poly, n) {
  const d = [0];
  for (let i = 1; i < poly.length; i++) d.push(d[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
  const total = d[d.length - 1] || 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1)) * total;
    let i = 1;
    while (i < d.length - 1 && d[i] < t) i++;
    const f = (t - d[i - 1]) / (d[i] - d[i - 1] || 1);
    out.push({ x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * f, y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * f });
  }
  return out;
}

// Bowyer–Watson Delaunay triangulation (fine for ~1000 points, done once per face)
function delaunay(pts) {
  const n = pts.length;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const dm = Math.max(maxX - minX, maxY - minY) * 20;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = pts.concat([{ x: mx - dm, y: my - dm }, { x: mx, y: my + dm }, { x: mx + dm, y: my - dm }]);
  const circ = (a, b, c) => {
    const A = P[a], B = P[b], C = P[c];
    const d = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
    if (Math.abs(d) < 1e-12) return { x: 0, y: 0, r: Infinity };
    const a2 = A.x * A.x + A.y * A.y, b2 = B.x * B.x + B.y * B.y, c2 = C.x * C.x + C.y * C.y;
    const x = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / d;
    const y = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / d;
    return { x, y, r: (x - A.x) ** 2 + (y - A.y) ** 2 };
  };
  let tris = [{ v: [n, n + 1, n + 2], c: circ(n, n + 1, n + 2) }];
  for (let i = 0; i < n; i++) {
    const p = P[i];
    const bad = [], keep = [];
    for (const t of tris) ((p.x - t.c.x) ** 2 + (p.y - t.c.y) ** 2 < t.c.r ? bad : keep).push(t);
    const edges = new Map();
    for (const t of bad) {
      for (let e = 0; e < 3; e++) {
        const a = t.v[e], b = t.v[(e + 1) % 3];
        const k = a < b ? a + ',' + b : b + ',' + a;
        if (edges.has(k)) edges.delete(k); else edges.set(k, [a, b]);
      }
    }
    for (const [a, b] of edges.values()) keep.push({ v: [a, b, i], c: circ(a, b, i) });
    tris = keep;
  }
  return tris.filter((t) => t.v.every((v) => v < n)).map((t) => t.v);
}

// ------------------------------------------------------------------ face rig
// Builds the mesh from landmarks (pixel coords). `lm` is either the full
// MediaPipe set (478 points) or a small synthetic set when detection fails.
export function buildRig(W, H, lm) {
  const pts = []; // {x, y, role, eye, lowY}
  const add = (x, y, extra = {}) => { pts.push({ x, y, ...extra }); return pts.length - 1; };
  const L = (i) => lm.points[i];

  // key measurements
  const m = lm.metrics;
  const { mx, my, mw, chinY, faceHalfW, faceCx, faceCy, faceRx, faceRy } = m;

  // 1) mouth seam: dense inner-lip contours, nudged 0.7px apart so the opening
  //    exists (as a hairline) even when the mouth is closed in the photo
  const up = resample(lm.innerUp, 30), low = resample(lm.innerLow, 30);
  const cornerA = add(up[0].x, up[0].y, { role: 'corner', r: { t: 'seamC', k: 0 } });
  const upIdx = [cornerA], lowIdx = [cornerA], pairs = [];
  for (let k = 1; k < 29; k++) {
    const a = add(up[k].x, Math.min(up[k].y, low[k].y) - 0.7, { role: 'up', r: { t: 'seamU', k } });
    const b = add(low[k].x, Math.max(up[k].y, low[k].y) + 0.7, { role: 'low', r: { t: 'seamL', k } });
    upIdx.push(a); lowIdx.push(b); pairs.push([a, b, pts[b].y - pts[a].y]);
  }
  const cornerB = add(up[29].x, up[29].y, { role: 'corner', r: { t: 'seamC', k: 29 } });
  upIdx.push(cornerB); lowIdx.push(cornerB);

  // 2) eyelids, densified; remember the lower lid under each upper-lid point
  lm.eyes.forEach((e, ei) => {
    const u = resample(e.up, 13), l = resample(e.low, 13);
    for (let k = 1; k < 12; k++) {
      add(u[k].x, u[k].y, { role: 'lid', eye: ei, lowY: l[k].y, r: { t: 'lidU', e: ei, k } });
      add(l[k].x, l[k].y, { role: 'lowlid', eye: ei, r: { t: 'lidL', e: ei, k } });
    }
    add(u[0].x, u[0].y, { eye: ei, r: { t: 'lidU', e: ei, k: 0 } });
    add(u[12].x, u[12].y, { eye: ei, r: { t: 'lidU', e: ei, k: 12 } });
  });

  // 3) every other landmark, skipping ones too close to points we already have
  const near = (x, y, r) => pts.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < r * r);
  lm.other.forEach((p, j) => {
    if (near(p.x, p.y, mw * 0.035)) return;
    const i = lm.otherIdx?.[j];
    add(p.x, p.y, { r: i == null ? { t: 'fixed' } : { t: 'lm', i } });
  });

  // 4) a light grid over the rest of the picture (hair, neck, background),
  //    plus the borders, so the whole image is one seamless mesh
  const g = 14;
  for (let r = 0; r <= g; r++) {
    for (let c = 0; c <= g; c++) {
      const x = (c / g) * W, y = (r / g) * H;
      const border = r === 0 || c === 0 || r === g || c === g;
      const inFace = ((x - faceCx) / (faceRx * 1.15)) ** 2 + ((y - faceCy) / (faceRy * 1.15)) ** 2 < 1;
      if (border || (!inFace && !near(x, y, mw * 0.25))) add(x, y, border ? { role: 'border', r: { t: 'fixed' } } : { r: { t: 'fixed' } });
    }
  }

  const tris = delaunay(pts);
  const isUp = new Set(upIdx), isLow = new Set(lowIdx);
  const skin = [], cavity = [];
  for (const t of tris) {
    const allSeam = t.every((v) => isUp.has(v) || isLow.has(v));
    const hasUp = t.some((v) => isUp.has(v) && pts[v].role !== 'corner');
    const hasLow = t.some((v) => isLow.has(v) && pts[v].role !== 'corner');
    if (allSeam && hasUp && hasLow) cavity.push(...t);
    else skin.push(...t);
  }

  // per-point weights that don't change: how much each point belongs to the
  // lower jaw, upper lip, lip area, and which eyelid
  const lowerHalf = faceHalfW;
  const jawLen = Math.max(1, chinY - my);
  for (const p of pts) {
    const dx = p.x - mx, adx = Math.abs(dx) / mw;
    let s;
    if (p.role === 'low') s = 1;
    else if (p.role === 'up') s = 0;
    else if (p.role === 'corner') s = 0.5;
    else {
      const a = mw * (0.05 + 0.8 * Math.max(0, adx - 0.45));
      s = smooth(my - a, my + a, p.y);
    }
    const hx = 1 - smooth(0.55, 1.12, Math.abs(dx) / lowerHalf);
    let k;
    if (p.y <= chinY) k = 1 + 0.25 * clamp((p.y - my) / jawLen);
    else k = 1.25 * (1 - smooth(0, jawLen * 0.9, p.y - chinY));
    // near the lips, the opening is oval: corners stay, the middle opens most
    const lipZone = Math.exp(-(((p.y - my) / (mw * 0.28)) ** 2));
    const taper = clamp(1 - Math.pow(adx / 0.55, 2.2), 0.25, 1);
    p.wJaw = p.role === 'border' ? 0 : s * hx * k * (1 - lipZone + lipZone * taper);
    p.wUpLip = p.y < my ? (1 - s) * Math.exp(-((dx / (mw * 0.45)) ** 2)) * Math.exp(-(((p.y - my) / (mw * 0.3)) ** 2)) : 0;
    p.wLips = p.role === 'border' ? 0 : Math.exp(-((dx / (mw * 0.75)) ** 2) - ((p.y - my) / (mw * 0.5)) ** 2);
    // eyelids
    p.wLid = 0; p.lidGap = 0;
    lm.eyes.forEach((e, ei) => {
      const ex = e.cx, ey = e.cy, ew = e.w, eh = e.h;
      if (p.role === 'lid' && p.eye === ei) { p.wLid = 1; p.lidGap = Math.max(0, p.lowY - p.y); return; }
      if (p.role === 'lowlid') return;
      const gx = Math.exp(-(((p.x - ex) / (ew * 0.65)) ** 2));
      const gy = p.y < ey ? smooth(ey - eh * 2.2, ey - eh * 0.45, p.y) : (p.y < ey + eh * 0.3 ? 0.5 : 0);
      const w = gx * gy;
      if (w > p.wLid) { p.wLid = w; p.lidGap = eh * 0.85; }
    });
  }

  // cavity coordinates: across the mouth (-1..1) and top lip (0) to bottom lip (1)
  for (const p of pts) {
    p.cu = (p.x - mx) / (mw / 2);
    p.cv = p.role === 'low' ? 1 : p.role === 'corner' ? 0.5 : 0;
  }
  // is the mouth already open in the photo (e.g. a smile showing teeth)?
  let restGap = 0;
  for (let k = 1; k < 29; k++) restGap += Math.max(0, low[k].y - up[k].y);
  restGap /= 28;
  return { pts, skin, cavity, pairs, metrics: m, openInPhoto: restGap > mw * 0.05 };
}

// Where each mesh point lands on another face (same recipe, other landmarks).
// Points with no facial meaning ('fixed') come back as NaN.
export function placeOn(rig, lm) {
  const up = resample(lm.innerUp, 30), low = resample(lm.innerLow, 30);
  const lids = lm.eyes.map((e) => ({ u: resample(e.up, 13), l: resample(e.low, 13) }));
  const out = new Float32Array(rig.pts.length * 2);
  rig.pts.forEach((p, i) => {
    const r = p.r || { t: 'fixed' };
    let q = null;
    if (r.t === 'lm') q = lm.points[r.i];
    else if (r.t === 'seamC') q = r.k === 0 ? up[0] : up[29];
    else if (r.t === 'seamU') q = { x: up[r.k].x, y: Math.min(up[r.k].y, low[r.k].y) };
    else if (r.t === 'seamL') q = { x: low[r.k].x, y: Math.max(up[r.k].y, low[r.k].y) };
    else if (r.t === 'lidU') q = lids[r.e].u[r.k];
    else if (r.t === 'lidL') q = lids[r.e].l[r.k];
    out[i * 2] = q ? q.x : NaN; out[i * 2 + 1] = q ? q.y : NaN;
  });
  return out;
}

// ------------------------------------------------------------------ WebGL
const VS = `
attribute vec2 aPos; attribute vec2 aUV; attribute vec2 aBaseUV; attribute vec2 aCav; attribute vec2 aGap; attribute float aW;
uniform vec2 uSize;
varying vec2 vUV; varying vec2 vBaseUV; varying vec2 vCav; varying vec2 vGap; varying float vW;
void main() {
  vUV = aUV; vBaseUV = aBaseUV; vCav = aCav; vGap = aGap; vW = aW;
  vec2 c = aPos / uSize * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;
const FS = `
precision mediump float;
uniform sampler2D uTex; uniform float uMode; uniform float uTeeth; uniform float uOpen;
uniform vec3 uLip; uniform float uReal; uniform vec2 uScreen;
uniform sampler2D uBlur; uniform sampler2D uBaseBlur; uniform float uKeep;
varying vec2 vUV; varying vec2 vBaseUV; varying vec2 vCav; varying vec2 vGap; varying float vW;
void main() {
  if (uMode < 0.5) {
    // one face's contribution (several faces are added together when morphing).
    // Another person's fine detail (eye shape, iris, brows, lips, skin texture)
    // is laid over the main photo's skin tone and lighting, so it all reads
    // as one face. uKeep = how much of their own colouring they keep.
    vec3 c = texture2D(uTex, vUV).rgb;
    vec3 cb = texture2D(uBlur, vUV).rgb;
    vec3 bb = texture2D(uBaseBlur, vBaseUV).rgb;
    vec3 col = clamp(c - cb + mix(bb, cb, uKeep), 0.0, 1.0);
    gl_FragColor = vec4(col * vW, 1.0);
    return;
  }
  // inside of the mouth: deep shadow, soft upper teeth, a hint of tongue
  float u = clamp(abs(vCav.x), 0.0, 1.0);
  float v = clamp(vCav.y, 0.0, 1.0);
  vec3 dark = mix(vec3(0.17, 0.065, 0.07), vec3(0.09, 0.03, 0.035), smoothstep(0.3, 0.9, u));
  vec3 col = mix(dark, uLip * 0.45, smoothstep(0.55, 1.0, u) * 0.6);
  float teeth = uTeeth * (1.0 - uReal) * (1.0 - smoothstep(0.22, 0.42, v)) * (1.0 - smoothstep(0.5, 0.88, u));
  vec3 teethCol = vec3(0.93, 0.9, 0.85) * (0.72 + 0.28 * (1.0 - u)) * (0.88 + 0.12 * smoothstep(0.0, 0.1, v));
  col = mix(col, teethCol, teeth * smoothstep(0.02, 0.18, uOpen));
  float tongue = smoothstep(0.62, 1.0, v) * (1.0 - smoothstep(0.4, 0.9, u)) * smoothstep(0.25, 0.6, uOpen);
  col = mix(col, vec3(0.5, 0.2, 0.21), tongue * 0.6);
  float lowTeeth = smoothstep(0.8, 0.95, v) * (1.0 - smoothstep(0.35, 0.7, u)) * smoothstep(0.35, 0.8, uOpen);
  col = mix(col, vec3(0.7, 0.66, 0.6), lowTeeth * 0.55);
  // soft shadow right under the lips
  col *= 0.75 + 0.25 * smoothstep(0.0, 0.08, v) * smoothstep(0.0, 0.1, 1.0 - v);
  // whatever the photo already shows between the lips (e.g. real teeth in a
  // smile) stays attached to the upper lip, unstretched; the new gap below is shadow
  float depth = v * vGap.y;
  float real = 1.0 - smoothstep(vGap.x + 0.3, vGap.x + 3.0, depth);
  vec2 suv = vec2(gl_FragCoord.x / uScreen.x, 1.0 - gl_FragCoord.y / uScreen.y);
  col = mix(col, texture2D(uTex, suv).rgb, real);
  gl_FragColor = vec4(col, 1.0);
}`;

export class MeshRenderer {
  constructor(W, H, image, rig) {
    this.W = W; this.H = H; this.rig = rig;
    const c = (this.canvas = document.createElement('canvas'));
    c.width = W; c.height = H;
    const gl = (this.gl = c.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: true, stencil: true }));
    if (!gl) throw new Error('WebGL not available');
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = (this.prog = gl.createProgram());
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const n = rig.pts.length;
    this.pos = new Float32Array(n * 2);
    const uv = new Float32Array(n * 2), cav = new Float32Array(n * 2);
    rig.pts.forEach((p, i) => {
      this.pos[i * 2] = p.x; this.pos[i * 2 + 1] = p.y;
      uv[i * 2] = p.x / W; uv[i * 2 + 1] = p.y / H;
      cav[i * 2] = p.cu; cav[i * 2 + 1] = p.cv;
    });
    const buf = (data, name, dyn) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, dyn ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      return b;
    };
    this.posBuf = buf(this.pos, 'aPos', true);
    this.ones = new Float32Array(n).fill(1);
    this.wBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.ones, gl.DYNAMIC_DRAW);
    this.wLoc = gl.getAttribLocation(prog, 'aW');
    gl.enableVertexAttribArray(this.wLoc);
    gl.vertexAttribPointer(this.wLoc, 1, gl.FLOAT, false, 0, 0);
    this.gap = new Float32Array(n * 2);
    for (const [a, b, g0] of rig.pairs) { this.gap[a * 2] = this.gap[b * 2] = g0; }
    this.gapBuf = buf(this.gap, 'aGap', true);
    this.uvLoc = gl.getAttribLocation(prog, 'aUV');
    const baseUV = buf(uv, 'aUV');
    buf(uv, 'aBaseUV');
    buf(cav, 'aCav');
    const idx = (arr) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(arr), gl.STATIC_DRAW); return { b, n: arr.length }; };
    this.skin = idx(rig.skin);
    this.cav = idx(rig.cavity);
    // faces[0] is the main photo; morph donors are added with addFace()
    this.faces = [{ tex: this._texture(image), blur: this._texture(blurred(image)), uv: baseUV, keep: 1 }];
    this.u = {};
    for (const k of ['uSize', 'uTex', 'uMode', 'uTeeth', 'uOpen', 'uLip', 'uReal', 'uScreen', 'uBlur', 'uBaseBlur', 'uKeep']) this.u[k] = gl.getUniformLocation(prog, k);
    gl.uniform1i(this.u.uBlur, 1);
    gl.uniform1i(this.u.uBaseBlur, 2);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.faces[0].blur);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(this.u.uSize, W, H);
    gl.uniform2f(this.u.uScreen, W, H);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform3fv(this.u.uLip, lipColor(image, rig.metrics));
    // if the photo already shows an open mouth, stretch the real teeth instead
    gl.uniform1f(this.u.uReal, rig.openInPhoto ? 1 : 0);
    gl.viewport(0, 0, W, H);
  }

  _texture(image) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    return tex;
  }

  // another person's face: its picture, where each mesh point sits on it
  // (texture coords 0..1), and a colour correction to match skin tones
  addFace(image, uv, keep = 0.35) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    this.faces.push({ tex: this._texture(image), blur: this._texture(blurred(image)), uv: b, keep });
    return this.faces.length - 1;
  }

  replaceFace(k, image, uv) {
    const gl = this.gl, f = this.faces[k];
    gl.deleteTexture(f.tex); gl.deleteTexture(f.blur);
    f.tex = this._texture(image); f.blur = this._texture(blurred(image));
    gl.bindBuffer(gl.ARRAY_BUFFER, f.uv);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  }

  // open 0..1, width (1 relaxed, <1 round, >1 spread), teeth 0..1, blink 0..1
  // rest: morphed face shape (or null = the photo's own shape)
  // layers: [{face, w: Float32Array per point}] weights that add up to 1
  render({ open = 0, width = 1, teeth = 0.5, blink = 0, rest = null, layers = null }) {
    const { gl, rig, pos } = this;
    const { mx, my, mw } = rig.metrics;
    const gap = open * mw * 0.23;
    const pucker = Math.max(0, 1 - width);
    const pts = rig.pts;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      let x = rest ? rest[i * 2] : p.x, y = rest ? rest[i * 2 + 1] : p.y;
      if (p.wJaw) y += gap * p.wJaw;
      if (p.wUpLip) y -= gap * 0.13 * p.wUpLip;
      if (p.wLips) {
        x += (width - 1) * (p.x - mx) * 0.9 * p.wLips;
        // rounded lips push forward and look a little fuller
        y += pucker * mw * 0.07 * Math.sign(p.y - my) * p.wLips * (p.role === 'up' || p.role === 'low' || p.role === 'corner' ? 0 : 1);
      }
      if (blink && p.wLid) y += blink * p.lidGap * p.wLid * 0.92;
      pos[i * 2] = x; pos[i * 2 + 1] = y;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    const gp = this.gap;
    for (const [a, b] of rig.pairs) gp[a * 2 + 1] = gp[b * 2 + 1] = pos[b * 2 + 1] - pos[a * 2 + 1];
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gapBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, gp);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(this.u.uMode, 0);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    // where the mesh folds over itself, count each pixel only once per face
    const multi = layers && layers.length > 1;
    if (multi) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.EQUAL, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.skin.b);
    for (const layer of layers || [{ face: 0, w: this.ones }]) {
      const f = this.faces[layer.face];
      gl.bindBuffer(gl.ARRAY_BUFFER, this.wBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, layer.w);
      gl.bindBuffer(gl.ARRAY_BUFFER, f.uv);
      gl.vertexAttribPointer(this.uvLoc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, f.blur);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.uniform1f(this.u.uKeep, f.keep);
      if (multi) gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.drawElements(gl.TRIANGLES, this.skin.n, gl.UNSIGNED_SHORT, 0);
    }
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    // mouth interior uses the main photo's own picture
    const base = this.faces[0];
    gl.bindBuffer(gl.ARRAY_BUFFER, base.uv);
    gl.vertexAttribPointer(this.uvLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, base.tex);
    gl.uniform1f(this.u.uMode, 1);
    gl.uniform1f(this.u.uTeeth, teeth);
    gl.uniform1f(this.u.uOpen, open);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cav.b);
    gl.drawElements(gl.TRIANGLES, this.cav.n, gl.UNSIGNED_SHORT, 0);
    return this.canvas;
  }

  // for checking the mesh lines up with the face (Settings > Show face mesh)
  drawDebug(ctx) {
    const { rig, pos } = this;
    ctx.save();
    ctx.lineWidth = 0.6;
    const tri = (arr, color) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 3) {
        const a = arr[i] * 2, b = arr[i + 1] * 2, c = arr[i + 2] * 2;
        ctx.moveTo(pos[a], pos[a + 1]); ctx.lineTo(pos[b], pos[b + 1]); ctx.lineTo(pos[c], pos[c + 1]); ctx.closePath();
      }
      ctx.stroke();
    };
    tri(rig.skin, 'rgba(79,209,255,0.35)');
    tri(rig.cavity, 'rgba(255,80,120,0.9)');
    ctx.restore();
  }
}

// a very soft version of a picture (its overall colour and lighting)
function blurred(image) {
  const s = 40 / Math.max(image.width, image.height);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(image.width * s)); c.height = Math.max(2, Math.round(image.height * s));
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  // shrink in steps so every pixel is averaged
  let src = image, w = image.width, h = image.height;
  while (w / 2 > c.width) {
    const t = document.createElement('canvas');
    t.width = Math.round(w / 2); t.height = Math.round(h / 2);
    const tx = t.getContext('2d'); tx.imageSmoothingQuality = 'high';
    tx.drawImage(src, 0, 0, t.width, t.height);
    src = t; w = t.width; h = t.height;
  }
  x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// average lip colour, used to tint the mouth corners naturally
function lipColor(image, m) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const x = c.getContext('2d');
    x.drawImage(image, m.mx - m.mw * 0.3, m.my + m.mw * 0.04, m.mw * 0.6, m.mw * 0.1, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4 * 255;
    return [r / n, g / n, b / n];
  } catch { return [0.6, 0.3, 0.3]; }
}

// ------------------------------------------------------------------ landmarks
// MediaPipe result (normalised) -> pixel landmarks + measurements
export function landmarksFromMediaPipe(p, W, H) {
  const P = p.map((q) => ({ x: q.x * W, y: q.y * H }));
  const used = new Set([...INNER_UP, ...INNER_LOW, ...EYES.flatMap((e) => [...e.up, ...e.low])]);
  const eyes = EYES.map((e) => {
    const up = e.up.map((i) => P[i]), low = e.low.map((i) => P[i]);
    const xs = up.map((q) => q.x);
    return {
      up, low,
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (P[e.up[4]].y + P[e.low[4]].y) / 2,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(2, P[e.low[4]].y - P[e.up[4]].y),
    };
  });
  const xs = P.slice(0, 468).map((q) => q.x), ys = P.slice(0, 468).map((q) => q.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return {
    innerUp: INNER_UP.map((i) => P[i]),
    innerLow: INNER_LOW.map((i) => P[i]),
    eyes,
    other: P.filter((_, i) => !used.has(i)),
    otherIdx: P.map((_, i) => i).filter((i) => !used.has(i)),
    points: P,
    metrics: {
      mx: (P[13].x + P[14].x) / 2,
      my: (P[13].y + P[14].y) / 2,
      mw: Math.hypot(P[291].x - P[61].x, P[291].y - P[61].y),
      chinY: P[152].y,
      faceHalfW: Math.abs(P[454].x - P[234].x) / 2,
      faceCx: (minX + maxX) / 2, faceCy: (minY + maxY) / 2,
      faceRx: (maxX - minX) / 2, faceRy: (maxY - minY) / 2,
    },
  };
}

// When detection isn't available: a simple face layout from rough positions
export function syntheticLandmarks(W, H, d) {
  const mx = d.mouth.x * W, my = d.mouth.y * H, mw = d.mouth.w * W;
  const chinY = d.chinY * H;
  const arc = (cx, cy, rx, ry, a0, a1, n) => Array.from({ length: n }, (_, i) => {
    const a = a0 + (a1 - a0) * (i / (n - 1));
    return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  });
  const innerUp = arc(mx, my, mw * 0.42, mw * 0.03, Math.PI, Math.PI * 2, 11);
  const innerLow = arc(mx, my, mw * 0.42, mw * 0.03, Math.PI, 0, 11);
  const eyes = d.eyes.map((e) => {
    const cx = e.x * W, cy = e.y * H, w = e.w * W, h = Math.max(4, e.h * H);
    return { up: arc(cx, cy, w / 2, h / 2, Math.PI, Math.PI * 2, 9), low: arc(cx, cy, w / 2, h / 2, Math.PI, 0, 9), cx, cy, w, h };
  });
  const faceHalfW = mw * 1.55;
  const faceCy = (d.eyes[0].y * H + chinY) / 2;
  const other = [
    ...arc(mx, my, mw * 0.55, mw * 0.17, 0, Math.PI * 2, 16), // outer lips
    ...arc(mx, my, mw * 0.85, mw * 0.4, 0, Math.PI * 2, 18),
    ...arc(mx, my, mw * 1.25, mw * 0.75, 0, Math.PI * 2, 20),
    ...arc(mx, faceCy, faceHalfW, chinY - faceCy, 0, Math.PI, 22), // jaw line
    ...arc(mx, faceCy, faceHalfW * 1.25, (chinY - faceCy) * 1.3, 0, Math.PI, 18),
    ...eyes.flatMap((e) => arc(e.cx, e.cy, e.w * 0.85, e.h * 3, 0, Math.PI * 2, 14)),
  ];
  return {
    innerUp, innerLow, eyes, other, points: [],
    metrics: { mx, my, mw, chinY, faceHalfW, faceCx: mx, faceCy, faceRx: faceHalfW, faceRy: chinY - faceCy + mw * 0.5 },
  };
}
