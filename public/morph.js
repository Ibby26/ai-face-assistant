// A face that never stops changing: the eyes, brows, nose, lips, cheekbones and
// jawline each blend, one after another, into features from other people.
// Every face is lined up on the same mesh (eyes locked in place so the gaze
// stays steady) and skin tones are matched, so it reads as one living face.

import { placeOn } from './mesh.js';

const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// MediaPipe landmark groups for each feature, and how far each one spreads
// (as a fraction of the distance between the eyes)
const EYE_IDX = [33, 246, 161, 160, 159, 158, 157, 173, 133, 7, 163, 144, 145, 153, 154, 155,
  263, 466, 388, 387, 386, 385, 384, 398, 362, 249, 390, 373, 374, 380, 381, 382,
  468, 469, 470, 471, 472, 473, 474, 475, 476, 477];
export const REGIONS = [
  { name: 'eyes', idx: EYE_IDX, spread: 0.2 },
  { name: 'brows', idx: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 300, 293, 334, 296, 336, 285, 295, 282, 283, 276], spread: 0.16 },
  { name: 'nose', idx: [1, 2, 4, 5, 6, 19, 94, 97, 98, 326, 327, 168, 195, 197, 129, 358, 49, 279, 48, 278, 64, 294, 122, 351], spread: 0.17 },
  { name: 'lips', idx: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 13, 14, 78, 308], spread: 0.17 },
  { name: 'cheeks', idx: [50, 280, 101, 330, 116, 345, 123, 352, 117, 346, 118, 347, 205, 425, 187, 411, 36, 266], spread: 0.26 },
  { name: 'jaw', idx: [152, 148, 176, 149, 150, 136, 172, 58, 132, 377, 400, 378, 379, 365, 397, 288, 361, 175, 199, 200, 18, 83, 313], spread: 0.22 },
];

function eyeCenters(lm) {
  return lm.eyes.map((e) => ({ x: e.cx, y: e.cy }));
}

// similarity transform that puts the donor's eyes exactly on the main face's eyes
function eyeAlign(base, donor) {
  const [b0, b1] = eyeCenters(base), [d0, d1] = eyeCenters(donor);
  const bv = { x: b1.x - b0.x, y: b1.y - b0.y }, dv = { x: d1.x - d0.x, y: d1.y - d0.y };
  const s = Math.hypot(bv.x, bv.y) / (Math.hypot(dv.x, dv.y) || 1);
  const a = Math.atan2(bv.y, bv.x) - Math.atan2(dv.y, dv.x);
  const c = Math.cos(a) * s, si = Math.sin(a) * s;
  const fwd = (p) => ({ x: b0.x + c * (p.x - d0.x) - si * (p.y - d0.y), y: b0.y + si * (p.x - d0.x) + c * (p.y - d0.y) });
  const inv = (p) => {
    const x = p.x - b0.x, y = p.y - b0.y, k = 1 / (s * s);
    return { x: d0.x + k * (c * x + si * y), y: d0.y + k * (-si * x + c * y) };
  };
  return { fwd, inv };
}

export class Morph {
  constructor(rig, baseLm, baseCanvas, renderer) {
    this.rig = rig;
    this.baseLm = baseLm;
    this.renderer = renderer;
    const n = rig.pts.length;
    this.n = n;
    // the main photo's own mesh positions
    const base = new Float32Array(n * 2);
    rig.pts.forEach((p, i) => { base[i * 2] = p.x; base[i * 2 + 1] = p.y; });
    this.shapes = [base]; // aligned face shapes, one per face
    this.rest = new Float32Array(n * 2);
    this.enabled = true;

    // how much each mesh point belongs to each feature (soft edges)
    const [e0, e1] = eyeCenters(baseLm);
    const iod = Math.hypot(e1.x - e0.x, e1.y - e0.y);
    this.member = REGIONS.map((reg) => {
      const pts = reg.idx.map((i) => baseLm.points[i]).filter(Boolean);
      const sig = reg.spread * iod;
      const m = new Float32Array(n);
      rig.pts.forEach((p, v) => {
        if (p.role === 'border') return;
        let d2 = Infinity;
        for (const q of pts) d2 = Math.min(d2, (p.x - q.x) ** 2 + (p.y - q.y) ** 2);
        m[v] = Math.exp(-d2 / (sig * sig));
      });
      return m;
    });
    // never more than 100% in total; whatever is left stays the main photo
    this.restW = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      let t = 0;
      for (const m of this.member) t += m[v];
      if (t > 1) for (const m of this.member) m[v] /= t;
      this.restW[v] = Math.max(0, 1 - Math.min(1, t));
    }

    // each feature has its own timer; they start one after another
    const now = performance.now();
    this.state = REGIONS.map((_, i) => ({ from: 0, to: 0, t0: 0, dur: 1, holdUntil: now + 1200 + i * 950 }));
    this.weights = [new Float32Array(n)];
  }

  get faceCount() { return this.shapes.length; }

  // add another person; returns false if their face couldn't be used
  addDonor(canvas, lm) {
    const { rig, baseLm } = this;
    // skip faces turned too far to the side; they don't line up well
    const [d0, d1] = eyeCenters(lm);
    const iod = Math.hypot(d1.x - d0.x, d1.y - d0.y);
    const nose = lm.points[1];
    const yaw = Math.abs((nose.x - (d0.x + d1.x) / 2) / iod);
    if (yaw > 0.42) { console.info('Morph: skipping a face that is turned to the side', yaw.toFixed(2)); return false; }
    console.info('Morph: using face, yaw', yaw.toFixed(2));
    const T = eyeAlign(baseLm, lm);
    const own = placeOn(rig, lm); // donor picture coords (NaN for background points)
    const W = canvas.width, H = canvas.height;
    const uv = new Float32Array(this.n * 2), shape = new Float32Array(this.n * 2);
    // a face turned a little to the side lends less of its shape
    const k = 0.75 * Math.max(0.3, 1 - yaw / 0.45);
    for (let v = 0; v < this.n; v++) {
      const bx = rig.pts[v].x, by = rig.pts[v].y;
      let px = own[v * 2], py = own[v * 2 + 1];
      if (Number.isNaN(px)) {
        const q = T.inv({ x: bx, y: by }); px = q.x; py = q.y;
        shape[v * 2] = bx; shape[v * 2 + 1] = by;
      } else {
        // take most (not all) of the other person's shape, which keeps the
        // face stable and avoids folds where faces differ a lot
        const q = T.fwd({ x: px, y: py });
        shape[v * 2] = bx + (q.x - bx) * k; shape[v * 2 + 1] = by + (q.y - by) * k;
      }
      uv[v * 2] = px / W; uv[v * 2 + 1] = py / H;
    }
    // skin tone and lighting come from the main photo (see mesh.js shader)
    this.renderer.addFace(canvas, uv, 0.35);
    this.shapes.push(shape);
    this.weights.push(new Float32Array(this.n));
    return true;
  }

  // works out this frame's face: shape (rest positions) and per-face layers
  update(now) {
    const K = this.shapes.length;
    if (!this.enabled || K < 2) return null;
    const shares = this.state.map((s) => {
      if (s.from === s.to && now > s.holdUntil) {
        let next;
        do { next = Math.floor(Math.random() * K); } while (next === s.from);
        s.to = next; s.t0 = now; s.dur = 2600 + Math.random() * 1800;
      }
      let p = 0;
      if (s.from !== s.to) {
        p = smooth((now - s.t0) / s.dur);
        if (p >= 1) { s.from = s.to; s.holdUntil = now + 700 + Math.random() * 1800; p = 0; }
      }
      return { from: s.from, to: s.to, p };
    });
    const n = this.n;
    for (const w of this.weights) w.fill(0);
    const base = this.weights[0];
    for (let v = 0; v < n; v++) base[v] = this.restW[v];
    shares.forEach((sh, r) => {
      const m = this.member[r];
      const wf = this.weights[sh.from], wt = this.weights[sh.to];
      const a = 1 - sh.p, b = sh.p;
      for (let v = 0; v < n; v++) {
        const mv = m[v];
        if (!mv) continue;
        wf[v] += mv * a;
        wt[v] += mv * b;
      }
    });
    const rest = this.rest;
    rest.fill(0);
    const layers = [];
    for (let k = 0; k < K; k++) {
      const w = this.weights[k], sh = this.shapes[k];
      let used = false;
      for (let v = 0; v < n; v++) {
        const wv = w[v];
        if (wv < 1e-4) continue;
        used = true;
        rest[v * 2] += wv * sh[v * 2];
        rest[v * 2 + 1] += wv * sh[v * 2 + 1];
      }
      if (used) layers.push({ face: k, w });
    }
    return { rest, layers };
  }
}
