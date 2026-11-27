// Eye contact: watches where you are through the camera (all on this device,
// nothing is uploaded) so the face can look at you and turn toward you.
let vision = null;

export class Presence {
  constructor() {
    this.x = 0; this.y = 0; // where you are, -1..1 (as seen from the face)
    this.seen = false; // a face is in view
    this.lastSeen = 0;
    this.on = false;
    this.onArrive = null; // called when you come back after being away
  }

  async start() {
    if (this.on) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false });
    } catch { return false; }
    this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: this.stream });
    await this.video.play().catch(() => {});
    if (!vision) vision = await import('/mp/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks('/mp/wasm');
    try {
      this.det = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'GPU' }, runningMode: 'VIDEO', numFaces: 1,
      });
    } catch {
      this.stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.on = true;
    this._tick();
    return true;
  }

  stop() {
    this.on = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.seen = false;
  }

  _tick() {
    if (!this.on) return;
    this.timer = setTimeout(() => this._tick(), 90); // ~11 times a second is plenty
    const v = this.video;
    if (!v || v.readyState < 2) return;
    let cx, cy;
    try {
      const now = performance.now();
      const p = this.det.detectForVideo(v, now).faceLandmarks?.[0];
      if (p) { cx = p[1].x; cy = p[1].y; }
    } catch { return; }
    const now = performance.now();
    if (cx == null) {
      if (now - this.lastSeen > 1500) this.seen = false;
      return;
    }
    if (!this.seen && now - this.lastSeen > 60000 && this.lastSeen) this.onArrive?.();
    this.seen = true;
    this.lastSeen = now;
    // the camera sees you mirrored: your left is its right
    const tx = Math.max(-1, Math.min(1, (0.5 - cx) * 2.6));
    const ty = Math.max(-1, Math.min(1, (cy - 0.45) * 2.4));
    this.x += (tx - this.x) * 0.35;
    this.y += (ty - this.y) * 0.35;
  }
}
