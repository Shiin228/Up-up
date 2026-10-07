// ---------------------------------------------------------------------------
// All sound is synthesized with the Web Audio API — square/triangle beeps and
// filtered noise. The AudioContext is only created after a user gesture.
// ---------------------------------------------------------------------------

import { Music, type MusicMode } from "./music";

type Wave = OscillatorType;

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private thrustGain: GainNode | null = null;
  private thrustSource: AudioBufferSourceNode | null = null;
  private thrustOn = false;
  private musicPlayer: Music | null = null;
  private musicEnabled: boolean;
  muted = false;

  constructor(muted: boolean, musicEnabled: boolean) {
    this.muted = muted;
    this.musicEnabled = musicEnabled;
  }

  /** Call from a user-gesture handler. Safe to call repeatedly. */
  unlock(): void {
    // Touch "pointerdown" is not a user activation; wait for one (e.g. pointerup)
    // instead of creating a context the browser will refuse to start.
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (activation && !activation.isActive) return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);

      const len = this.ctx.sampleRate;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      this.musicPlayer = new Music(this.ctx, this.master, this.noiseBuffer, this.musicEnabled);
      this.musicPlayer.start();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    this.musicPlayer?.setEnabled(enabled);
  }

  /** Background music mix: which layers play and how loud (call every frame). */
  music(mode: MusicMode, layer: number): void {
    this.musicPlayer?.update(mode, layer);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.01);
    }
  }

  private ready(): AudioContext | null {
    if (!this.ctx || !this.master || this.muted || this.ctx.state !== "running") return null;
    return this.ctx;
  }

  /** A single beep with an exponential pitch sweep and a quick decay. */
  private tone(wave: Wave, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number, type: BiquadFilterType = "lowpass", delay = 0): void {
    const ctx = this.ready();
    if (!ctx || !this.noiseBuffer) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  /** Rising blip while charging; level is 0..1. */
  charge(level: number): void {
    this.tone("square", 220 + level * 520, 240 + level * 560, 0.04, 0.05);
  }

  jump(charge: number): void {
    this.tone("square", 260 + charge * 120, 620 + charge * 380, 0.14, 0.09);
  }

  land(intensity: number): void {
    const v = 0.08 + 0.18 * intensity;
    this.tone("triangle", 160, 50, 0.1 + intensity * 0.08, v);
    if (intensity > 0.5) this.noise(0.12, 0.08 * intensity, 600);
  }

  crumbleStart(): void {
    this.noise(0.18, 0.06, 1800, "bandpass");
  }

  crumble(): void {
    this.noise(0.35, 0.16, 900);
    this.tone("square", 110, 45, 0.25, 0.05);
  }

  pickup(): void {
    this.tone("square", 660, 660, 0.06, 0.07);
    this.tone("square", 880, 880, 0.06, 0.07, 0.06);
    this.tone("square", 1320, 1760, 0.1, 0.07, 0.12);
  }

  empty(): void {
    this.tone("square", 140, 90, 0.08, 0.05);
  }

  gameOver(): void {
    [440, 370, 311, 220].forEach((f, i) => this.tone("square", f, f * 0.97, 0.16, 0.08, i * 0.15));
    this.tone("triangle", 110, 40, 0.6, 0.12, 0.6);
  }

  /** Danger beep when the rising bottom edge is close. */
  warn(): void {
    this.tone("square", 990, 990, 0.05, 0.04);
  }

  click(): void {
    this.tone("square", 520, 520, 0.04, 0.05);
  }

  /** Soft looping noise for the jetpack. */
  thrust(on: boolean): void {
    if (on === this.thrustOn) return;
    this.thrustOn = on;
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuffer) return;
    if (!this.thrustSource) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 700;
      filter.Q.value = 0.8;
      this.thrustGain = ctx.createGain();
      this.thrustGain.gain.value = 0;
      src.connect(filter).connect(this.thrustGain).connect(this.master);
      src.start();
      this.thrustSource = src;
    }
    this.thrustGain!.gain.setTargetAtTime(on ? 0.11 : 0, ctx.currentTime, 0.025);
  }

  destroy(): void {
    this.musicPlayer?.stop();
    this.musicPlayer = null;
    try {
      this.thrustSource?.stop();
    } catch {
      /* already stopped */
    }
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.thrustSource = null;
    this.thrustGain = null;
  }
}
