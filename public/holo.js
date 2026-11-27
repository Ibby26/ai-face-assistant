// The hologram around the face: rotating HUD rings, a ring of light bars that
// moves with the voice, and orbiting particles. Colour follows what it's doing.
const COLORS = {
  idle: [79, 209, 255],
  listening: [80, 255, 200],
  thinking: [163, 107, 255],
  speaking: [120, 200, 255],
};

export class Holo {
  constructor(canvas, { getMode, getLevel, getSpectrum, getLabel }) {
    this.c = canvas;
    this.x = canvas.getContext('2d');
    Object.assign(this, { getMode, getLevel, getSpectrum, getLabel });
    this.col = [...COLORS.idle];
    this.spin = 0;
    this.energy = 0;
    this.on = true;
    this.parts = Array.from({ length: 110 }, () => ({
      a: Math.random() * Math.PI * 2,
      r: 0.9 + Math.random() * 0.45,
      s: (0.05 + Math.random() * 0.25) * (Math.random() < 0.5 ? -1 : 1),
      z: Math.random(),
    }));
    this.bars = new Float32Array(96);
    this.faceless = false;
    this.orbLevel = 0;
    this._resize = () => {
      const d = Math.min(2, devicePixelRatio || 1);
      canvas.width = innerWidth * d; canvas.height = innerHeight * d;
      this.d = d;
    };
    addEventListener('resize', this._resize);
    this._resize();
    this.last = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  _frame(now) {
    requestAnimationFrame((t) => this._frame(t));
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const { x, c, d } = this;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, c.width, c.height);
    if (!this.on) return;
    x.setTransform(d, 0, 0, d, 0, 0);
    const W = innerWidth, H = innerHeight;
    const mode = this.getMode();
    const target = COLORS[mode] || COLORS.idle;
    for (let i = 0; i < 3; i++) this.col[i] += (target[i] - this.col[i]) * 0.06;
    const [r, g, b] = this.col.map(Math.round);
    const rgba = (a) => `rgba(${r},${g},${b},${a})`;
    const level = this.getLevel();
    this.orbLevel += (level - this.orbLevel) * 0.35;
    this.energy += ((mode === 'thinking' ? 0.8 : mode === 'speaking' ? 0.45 + level : mode === 'listening' ? 0.6 : 0.2) - this.energy) * 0.05;
    this.spin += dt * (0.15 + this.energy * 0.9);

    const cx = W / 2, cy = H / 2;
    const R = Math.min(H * 0.47, W * 0.6);
    x.globalCompositeOperation = 'lighter';
    x.lineCap = 'round';

    // HUD rings
    const ring = (rad, width, alpha, dash, rot, arc = Math.PI * 2) => {
      x.save();
      x.translate(cx, cy); x.rotate(rot);
      x.setLineDash(dash);
      x.strokeStyle = rgba(alpha); x.lineWidth = width;
      x.beginPath(); x.arc(0, 0, rad, 0, arc); x.stroke();
      x.restore();
    };
    ring(R * 1.02, 1, 0.22, [2, 7], this.spin * 0.3);
    ring(R * 1.08, 2, 0.28 + this.energy * 0.2, [R * 0.5, R * 0.18], -this.spin * 0.5, Math.PI * 1.6);
    ring(R * 1.15, 1, 0.16, [1, 3], this.spin * 0.15);
    ring(R * 0.97, 3, 0.18 + this.energy * 0.25, [R * 0.06, R * 0.3], this.spin * 1.1, Math.PI * 1.2);
    // tick marks
    x.save(); x.translate(cx, cy); x.rotate(-this.spin * 0.08);
    x.strokeStyle = rgba(0.3); x.lineWidth = 1; x.setLineDash([]);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2, long = i % 6 === 0;
      x.beginPath();
      x.moveTo(Math.cos(a) * R * 1.19, Math.sin(a) * R * 1.19);
      x.lineTo(Math.cos(a) * R * (long ? 1.23 : 1.21), Math.sin(a) * R * (long ? 1.23 : 1.21));
      x.stroke();
    }
    x.restore();

    // voice bars around the face
    const spec = this.getSpectrum();
    const n = this.bars.length;
    for (let i = 0; i < n; i++) {
      // mirror so the ring is symmetric, low notes at the bottom
      const k = i < n / 2 ? i : n - 1 - i;
      let v;
      if (spec) v = spec[2 + Math.floor((k / (n / 2)) * spec.length * 0.45)] / 255;
      else v = (mode === 'listening' ? 0.25 : 0.06) * (0.5 + 0.5 * Math.sin(now / 300 + k * 0.7));
      this.bars[i] += (v - this.bars[i]) * (v > this.bars[i] ? 0.5 : 0.12);
    }
    x.save(); x.translate(cx, cy);
    x.lineWidth = Math.max(2, R * 0.012);
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 + (i / n) * Math.PI * 2;
      const v = this.bars[i];
      const r0 = R * 1.26, r1 = r0 + 4 + v * R * 0.22;
      x.strokeStyle = rgba(0.18 + v * 0.7);
      x.beginPath(); x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); x.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); x.stroke();
    }
    x.restore();

    // orbiting particles
    for (const p of this.parts) {
      p.a += p.s * dt * (0.6 + this.energy * 2.2);
      const rr = R * p.r * (1 + 0.04 * Math.sin(now / 900 + p.z * 9));
      const px = cx + Math.cos(p.a) * rr, py = cy + Math.sin(p.a) * rr * 0.98;
      const size = 0.6 + p.z * 1.8;
      x.fillStyle = rgba(0.25 + p.z * 0.5);
      x.fillRect(px - size / 2, py - size / 2, size, size);
    }

    // no face: a living energy orb in the middle that speaks
    if (this.faceless) this._orb(x, cx, cy, R, level, now, rgba);

    // labels
    x.globalCompositeOperation = 'source-over';
    x.font = `600 ${Math.max(10, R * 0.026)}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
    x.fillStyle = rgba(0.75);
    x.textAlign = 'center';
    const label = this.getLabel();
    const tY = cy - R * 1.31;
    if (tY > 64) x.fillText(label, cx, tY);
    const t = new Date();
    x.fillStyle = rgba(0.45);
    const bY = cy + R * 1.36;
    if (bY < H - 150) x.fillText(`${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ·  LINK ${mode === 'idle' ? 'STANDBY' : 'ACTIVE'}`, cx, bY);
  }

  _orb(x, cx, cy, R, level, now, rgba) {
    const t = now / 1000;
    const lv = this.orbLevel;
    const r = R * (0.42 + lv * 0.08 + 0.012 * Math.sin(t * 2.1)) * (1 + this.energy * 0.04);
    // soft outer glow
    let g = x.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.6);
    g.addColorStop(0, rgba(0.35 + lv * 0.3));
    g.addColorStop(0.55, rgba(0.08));
    g.addColorStop(1, rgba(0));
    x.fillStyle = g;
    x.beginPath(); x.arc(cx, cy, r * 1.6, 0, Math.PI * 2); x.fill();
    // the core
    g = x.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.05, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.25, rgba(0.75));
    g.addColorStop(0.8, 'rgba(110,70,255,0.35)');
    g.addColorStop(1, rgba(0));
    x.fillStyle = g;
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    // energy bands swirling inside, wobbling with the voice
    x.lineWidth = 1.4;
    for (let i = 0; i < 7; i++) {
      const a = t * (0.4 + i * 0.13) * (i % 2 ? -1 : 1) + i;
      x.save();
      x.translate(cx, cy); x.rotate(a);
      x.scale(1, 0.25 + 0.7 * Math.abs(Math.sin(t * 0.5 + i)));
      x.strokeStyle = rgba(0.18 + lv * 0.45);
      x.beginPath();
      for (let k = 0; k <= 64; k++) {
        const th = (k / 64) * Math.PI * 2;
        const wob = 1 + lv * 0.12 * Math.sin(th * 6 + t * 9 + i) + 0.03 * Math.sin(th * 3 - t * 2);
        const px = Math.cos(th) * r * 0.82 * wob, py = Math.sin(th) * r * 0.82 * wob;
        k ? x.lineTo(px, py) : x.moveTo(px, py);
      }
      x.stroke();
      x.restore();
    }
  }
}
