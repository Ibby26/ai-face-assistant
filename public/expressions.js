// Facial expressions and eye movement on the face mesh: smiles, raised or
// knitted brows, sadness, surprise, plus the irises moving to look at you.
// Each expression is a soft displacement field built from MediaPipe landmarks.

const g = (d2, s) => Math.exp(-d2 / (s * s));

export const MOODS = {
  neutral: { smile: 0.12 },
  happy: { smile: 0.75 },
  excited: { smile: 0.9, surprise: 0.45 },
  sad: { sad: 0.8 },
  surprised: { surprise: 0.85, smile: 0.1 },
  thinking: { frown: 0.35, surprise: 0.1 },
  serious: { frown: 0.55 },
  listening: { surprise: 0.22, smile: 0.12 },
};

export class Expressions {
  constructor(rig, lm) {
    this.rig = rig;
    const P = lm.points;
    const n = rig.pts.length;
    this.n = n;
    const { mx, mw } = lm.metrics;
    const [e0, e1] = lm.eyes;
    const iod = Math.hypot(e1.cx - e0.cx, e1.cy - e0.cy);
    this.eyes = lm.eyes;
    const side = (i) => Math.sign(P[i].x - mx) || 1;
    // anchors: [landmark, dx, dy, spread]
    const defs = {
      smile: [
        [61, 0.1 * mw * side(61), -0.13 * mw, 0.34 * mw],
        [291, 0.1 * mw * side(291), -0.13 * mw, 0.34 * mw],
        [205, 0, -0.06 * mw, 0.45 * mw], [425, 0, -0.06 * mw, 0.45 * mw], // cheeks lift
        [145, 0, -0.025 * iod, 0.1 * iod], [374, 0, -0.025 * iod, 0.1 * iod], // eyes squint a little
      ],
      sad: [
        [61, -0.03 * mw * side(61), 0.11 * mw, 0.3 * mw], [291, -0.03 * mw * side(291), 0.11 * mw, 0.3 * mw],
        [107, 0, -0.1 * iod, 0.13 * iod], [336, 0, -0.1 * iod, 0.13 * iod], // inner brows up
        [70, 0, 0.025 * iod, 0.12 * iod], [300, 0, 0.025 * iod, 0.12 * iod],
      ],
      surprise: [
        [105, 0, -0.13 * iod, 0.22 * iod], [334, 0, -0.13 * iod, 0.22 * iod],
        [107, 0, -0.1 * iod, 0.15 * iod], [336, 0, -0.1 * iod, 0.15 * iod],
        [159, 0, -0.025 * iod, 0.08 * iod], [386, 0, -0.025 * iod, 0.08 * iod], // eyes widen
      ],
      frown: [
        [107, 0.05 * iod * -side(107), 0.07 * iod, 0.14 * iod], [336, 0.05 * iod * -side(336), 0.07 * iod, 0.14 * iod],
        [55, 0.04 * iod * -side(55), 0.05 * iod, 0.1 * iod], [285, 0.04 * iod * -side(285), 0.05 * iod, 0.1 * iod],
        [61, 0, 0.015 * mw, 0.25 * mw], [291, 0, 0.015 * mw, 0.25 * mw],
      ],
    };
    this.bases = {};
    for (const [name, anchors] of Object.entries(defs)) {
      const d = new Float32Array(n * 2);
      rig.pts.forEach((p, v) => {
        if (p.role === 'border') return;
        let dx = 0, dy = 0;
        for (const [i, ax, ay, s] of anchors) {
          const q = P[i];
          if (!q) continue;
          const w = g((p.x - q.x) ** 2 + (p.y - q.y) ** 2, s);
          dx += ax * w; dy += ay * w;
        }
        d[v * 2] = dx; d[v * 2 + 1] = dy;
      });
      this.bases[name] = d;
    }
    // irises (MediaPipe 468-477) and how much each one follows the gaze
    this.iris = new Float32Array(n);
    rig.pts.forEach((p, v) => { if (p.r?.t === 'lm' && p.r.i >= 468) this.iris[v] = 1; });
    this.base = new Float32Array(n * 2);
    rig.pts.forEach((p, v) => { this.base[v * 2] = p.x; this.base[v * 2 + 1] = p.y; });
    this.out = new Float32Array(n * 2);
    this.w = { smile: 0, sad: 0, surprise: 0, frown: 0 };
  }

  // weights: target expression mix; gaze: {x, y} in -1..1; rest: morphed shape or null
  apply(target, gaze, rest, ease = 0.06) {
    const w = this.w;
    for (const k of Object.keys(w)) w[k] += ((target[k] || 0) - w[k]) * ease;
    const src = rest || this.base, out = this.out, n = this.n;
    out.set(src);
    for (const [k, d] of Object.entries(this.bases)) {
      const a = w[k];
      if (Math.abs(a) < 0.003) continue;
      for (let i = 0; i < n * 2; i++) out[i] += d[i] * a;
    }
    if (gaze) {
      const e = this.eyes[0];
      const gx = gaze.x * e.w * 0.11, gy = gaze.y * e.h * 0.28;
      for (let v = 0; v < n; v++) if (this.iris[v]) { out[v * 2] += gx; out[v * 2 + 1] += gy; }
    }
    return out;
  }
}
