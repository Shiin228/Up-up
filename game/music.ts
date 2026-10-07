// ---------------------------------------------------------------------------
// Background music: a looping 8-bit "space" track synthesized on the fly.
// NES-style pulse arpeggios with a spacey echo, a triangle bass, a soft
// melody and hi-hats. Layers fade in as the sky goes sunset → night → space.
// Notes are scheduled slightly ahead of time with a lookahead timer, so the
// rhythm stays tight regardless of frame rate.
// ---------------------------------------------------------------------------

const BPM = 92;
const SIXTEENTH = 60 / BPM / 4;
const STEPS_PER_BAR = 16;
/** Seconds of notes scheduled ahead of the audio clock. */
const LOOKAHEAD = 0.15;
const TICK_MS = 25;

const VOLUME = { normal: 0.6, title: 0.5, duck: 0.18 };

const freq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** Eight bars, one chord each: bass root and four arpeggio tones (MIDI). */
const CHORDS: readonly { root: number; tones: readonly number[] }[] = [
  { root: 45, tones: [57, 60, 64, 71] }, // Am(add9)
  { root: 41, tones: [57, 60, 64, 65] }, // Fmaj7
  { root: 48, tones: [60, 64, 67, 71] }, // Cmaj7
  { root: 43, tones: [55, 59, 62, 69] }, // G(add9)
  { root: 45, tones: [57, 60, 64, 71] }, // Am(add9)
  { root: 41, tones: [57, 60, 65, 69] }, // F
  { root: 38, tones: [57, 62, 65, 72] }, // Dm7
  { root: 40, tones: [56, 59, 62, 64] }, // E7
];

/** Arpeggio per bar: chord tone index; 4–7 are the same tones an octave up. */
const ARP = [0, 1, 2, 3, 5, 6, 3, 2, 0, 1, 2, 3, 6, 5, 3, 1];
/** Bass hits within a bar (sixteenth steps) and their lengths in steps. */
const BASS: Record<number, number> = { 0: 5, 6: 2, 8: 3, 11: 2, 14: 2 };
/** Melody: two notes per bar (on steps 0 and 8), null = rest. */
const MELODY: readonly (number | null)[] = [
  76, null, 74, 72, 76, 79, 74, null, 72, 71, 72, 76, 69, 72, 71, 68,
];
const HAT_STEPS = new Set([2, 6, 10, 14]);

export type MusicMode = "title" | "play" | "duck";

export class Music {
  private readonly out: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly pulse: PeriodicWave;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private mode: MusicMode = "title";
  private layer = 0;
  private enabled: boolean;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly noise: AudioBuffer,
    enabled: boolean,
  ) {
    this.enabled = enabled;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    // Dry bus (bass, hats) and wet bus (arp, melody) with a feedback echo.
    this.dry = ctx.createGain();
    this.dry.connect(this.out);
    this.wet = ctx.createGain();
    this.wet.connect(this.out);
    const delay = ctx.createDelay(1);
    delay.delayTime.value = SIXTEENTH * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const echo = ctx.createGain();
    echo.gain.value = 0.35;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    this.wet.connect(delay);
    delay.connect(tone).connect(feedback).connect(delay);
    tone.connect(echo).connect(this.out);

    // 25% duty pulse wave — the classic NES lead timbre.
    const n = 32;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
    this.pulse = ctx.createPeriodicWave(real, imag);
  }

  start(): void {
    if (this.timer !== null) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(this.schedule, TICK_MS);
    this.applyVolume();
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.out.disconnect();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.applyVolume();
  }

  /** Called every frame; only acts when something changed. */
  update(mode: MusicMode, layer: number): void {
    if (mode === this.mode && layer === this.layer) return;
    this.mode = mode;
    this.layer = layer;
    this.applyVolume();
  }

  private applyVolume(): void {
    const target = this.enabled ? VOLUME[this.mode === "play" ? "normal" : this.mode] : 0;
    this.out.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
  }

  private schedule = (): void => {
    const now = this.ctx.currentTime;
    // After the tab was suspended, skip ahead instead of firing a burst of notes.
    if (this.nextTime < now - 0.2) this.nextTime = now + 0.05;
    while (this.nextTime < now + LOOKAHEAD) {
      if (this.enabled) this.playStep(this.step, this.nextTime);
      this.nextTime += SIXTEENTH;
      this.step = (this.step + 1) % (STEPS_PER_BAR * CHORDS.length);
    }
  };

  private playStep(step: number, t: number): void {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const s = step % STEPS_PER_BAR;
    const chord = CHORDS[bar];

    // Arpeggio (always).
    const i = ARP[s];
    const note = chord.tones[i % 4] + (i >= 4 ? 12 : 0);
    this.note(this.pulse, freq(note), t, SIXTEENTH * 0.9, 0.05, this.wet);

    // Bass (always).
    const len = BASS[s];
    if (len) this.note("triangle", freq(chord.root), t, SIXTEENTH * len, 0.16, this.dry);

    // Night and higher: a slow, soft melody.
    if (this.layer >= 1 && s % 8 === 0) {
      const m = MELODY[bar * 2 + s / 8];
      if (m !== null) this.note("triangle", freq(m), t, SIXTEENTH * 7, 0.11, this.wet, true);
    }

    // Space, while playing: hi-hats.
    if (this.layer >= 2 && this.mode === "play" && HAT_STEPS.has(s)) this.hat(t);
  }

  private note(
    wave: OscillatorType | PeriodicWave,
    hz: number,
    t: number,
    dur: number,
    vol: number,
    bus: AudioNode,
    vibrato = false,
  ): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    if (wave instanceof PeriodicWave) osc.setPeriodicWave(wave);
    else osc.type = wave;
    osc.frequency.setValueAtTime(hz, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(bus);
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5;
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(hz * 0.012, t + dur * 0.5);
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.02);
    }
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private hat(t: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.035, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(hp).connect(g).connect(this.dry);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.05);
  }
}
