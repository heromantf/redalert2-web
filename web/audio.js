// The game's sound on the page: an AudioContext at the mixer's rate (no
// resampling), audio-worklet.js reading wasi/sdl.c's ring, into the speakers.
// A browser starts sound only after a gesture on the page: until the first
// click or key the context waits, the ring is not active, and the mixer keeps
// its own clock (sdl.c); once the context runs the ring is active and the
// sound card's clock paces the mixer.
//   startAudio(memory, ptr, { log }) -> { resume(), state(), capture(seconds), underruns() }
// capture: the next seconds of what the speakers get, as interleaved stereo
// floats (the tests save them as a WAV: tools/chrome.mjs --wav).
export function startAudio(memory, ptr, { log = () => {}, every = 5 } = {}) {
  const hdr = new Uint32Array(memory.buffer, ptr, 8);
  const rate = hdr[3];
  const ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  let node = null, reported = 0, captured = null;
  const setActive = () => Atomics.store(hdr, 5, ctx.state === 'running' && node ? 1 : 0);
  ctx.onstatechange = () => { setActive(); log(`[audio] ${ctx.state}, ${ctx.sampleRate} Hz, output latency ${((ctx.outputLatency || ctx.baseLatency) * 1000).toFixed(0)} ms`); };
  const ready = ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url)).then(() => {
    node = new AudioWorkletNode(ctx, 'ra2web-audio', { numberOfInputs: 0, outputChannelCount: [2] });
    node.port.onmessage = (e) => {
      const s = e.data;
      if (s.captured) { captured?.(s.captured); captured = null; return; }
      if (++reported % every === 1 || every === 1)
        log(`[audio] rms ${s.rms.toFixed(4)}, peak ${s.peak.toFixed(3)}, ${s.played} frames played in the last second, ${s.underruns} short quanta so far`);
    };
    node.port.postMessage({ sab: memory.buffer, ptr });
    node.connect(ctx.destination);
    setActive();
  });
  const resume = () => { if (ctx.state !== 'running') ready.then(() => ctx.resume()); };
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { capture: true });
  resume();                                          // allowed without a gesture where the browser says so
  const capture = (seconds) => ready.then(() => new Promise((res) => { captured = res; node.port.postMessage({ capture: Math.round(seconds * rate) }); }));
  return { resume, state: () => ctx.state, capture, rate, underruns: () => Atomics.load(hdr, 6) };
}
