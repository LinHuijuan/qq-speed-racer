/** Lightweight procedural engine / boost audio using Web Audio API. */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private started = false;
  private muted = false;

  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.18;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.18, this.ctx.currentTime, 0.05);
    }
  }

  startEngine(): void {
    if (!this.ctx || !this.master || this.started) return;
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 40;

    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;

    this.engineOsc.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();
    this.started = true;
  }

  updateEngine(speedRatio: number, boosting: boolean): void {
    if (!this.ctx || !this.engineOsc || !this.engineGain || !this.engineFilter) return;
    const now = this.ctx.currentTime;
    // More dramatic pitch climb at high speed / boost
    const freq = 42 + speedRatio * 120 + (boosting ? 55 : 0) + Math.sin(now * 18) * 4 * speedRatio;
    this.engineOsc.frequency.setTargetAtTime(freq, now, 0.05);
    this.engineFilter.frequency.setTargetAtTime(280 + speedRatio * 1400 + (boosting ? 700 : 0), now, 0.08);
    this.engineGain.gain.setTargetAtTime(0.04 + speedRatio * 0.16 + (boosting ? 0.1 : 0), now, 0.08);
  }

  whoosh(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(280, now);
    filter.frequency.exponentialRampToValueAtTime(1800, now + 0.35);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(720, now + 0.4);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.5);
  }

  /**
   * Short scrape burst when the kart slides against a guardrail. A 120 ms
   * brown-noise buffer through a 1.4 kHz band-pass, so the burst reads as
   * friction/gravel rather than an engine note.
   *
   * The Game loop rate-limits calls (~250 ms apart) because the collision
   * detection fires every frame the kart is in contact with the wall.
   */
  scrape(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const now = this.ctx.currentTime;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.12, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      // Brown-ish noise: random walk is cheaper than white and feels like
      // gravel rather than static.
      const r = (Math.random() * 2 - 1) * 0.6;
      data[i] = i === 0 ? r : (data[i - 1] * 0.7 + r);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400;
    filter.Q.value = 0.9;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(now);
    src.stop(now + 0.13);
  }

  countdownBeep(high = false): void {
    if (!this.ctx || !this.master || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = high ? 880 : 440;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (high ? 0.35 : 0.18));
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.4);
  }

  dispose(): void {
    try {
      this.engineOsc?.stop();
    } catch {
      // already stopped
    }
    this.engineOsc?.disconnect();
    this.engineGain?.disconnect();
    this.engineFilter?.disconnect();
    this.master?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
