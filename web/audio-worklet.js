// The game's sound, on the browser's audio thread: wasi/sdl.c's ring (shared
// memory) into the speakers. The ring: 32-bit words 0 write, 1 read (frames,
// counted for ever), 2 frames (a power of two), 3 rate, 4 channels (2),
// 5 active, 6 underruns; from byte 32 the samples, interleaved 16-bit stereo.
// Each 128-frame quantum takes what the ring has; a short one is filled with
// silence and counted. Once a second it tells the page how loud the sound was
// (RMS) and how many quanta came short, so a test can see there is sound; and
// on request ({ capture: frames }) it keeps that much of what it plays and
// posts it back ({ captured }: interleaved stereo floats), for a test to save.
class Ra2webAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hdr = null;
    this.sum = 0; this.n = 0; this.peak = 0; this.since = 0;
    this.cap = null; this.capAt = 0;
    this.port.onmessage = (e) => {
      if (e.data.capture) { this.cap = new Float32Array(e.data.capture * 2); this.capAt = 0; return; }
      const { sab, ptr } = e.data;
      this.hdr = new Uint32Array(sab, ptr, 8);
      this.frames = this.hdr[2];
      this.pcm = new Int16Array(sab, ptr + 32, this.frames * 2);
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] ?? out[0], n = L.length;
    if (!this.hdr) { L.fill(0); R.fill(0); return true; }
    const w = Atomics.load(this.hdr, 0), r = Atomics.load(this.hdr, 1);
    const k = Math.min(n, (w - r) >>> 0), mask = this.frames - 1, pcm = this.pcm;
    for (let i = 0; i < k; i++) {
      const j = ((r + i) & mask) * 2, a = pcm[j] / 32768, b = pcm[j + 1] / 32768;
      L[i] = a; R[i] = b;
      this.sum += a * a + b * b;
      const m = Math.max(Math.abs(a), Math.abs(b)); if (m > this.peak) this.peak = m;
    }
    for (let i = k; i < n; i++) L[i] = R[i] = 0;
    if (this.cap) {
      for (let i = 0; i < n && this.capAt < this.cap.length; i++) { this.cap[this.capAt++] = L[i]; this.cap[this.capAt++] = R[i]; }
      if (this.capAt >= this.cap.length) { this.port.postMessage({ captured: this.cap }, [this.cap.buffer]); this.cap = null; }
    }
    this.n += k;
    if (k < n) Atomics.add(this.hdr, 6, 1);
    Atomics.store(this.hdr, 1, (r + k) >>> 0);
    this.since += n;
    if (this.since >= sampleRate) {
      this.port.postMessage({ rms: this.n ? Math.sqrt(this.sum / (2 * this.n)) : 0, peak: this.peak, underruns: this.hdr[6], played: this.n });
      this.sum = 0; this.n = 0; this.peak = 0; this.since = 0;
    }
    return true;
  }
}
registerProcessor('ra2web-audio', Ra2webAudio);
