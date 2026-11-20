(function (global) {
  'use strict';

  class SoundFX {
    constructor() {
      this.enabled = true;
      this.bgmEnabled = true;
      this.ctx = null;
      this.musicGain = null;
      this.bgmGain = null;
      this.activeMusicNodes = [];

      // Cerebral Strategy BGM lookahead scheduler state
      this.bgmRunning = false;
      this.bgmTimer = null;
      this.bgmStep = 0;
      this.bgmNextTime = 0;
    }

    _ensureCtx() {
      if (!this.enabled) return null;
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    _getMusicBus(ctx) {
      if (!this.musicGain) {
        this.musicGain = ctx.createGain();
        this.musicGain.gain.value = 0.85;
        this.musicGain.connect(ctx.destination);
      }
      return this.musicGain;
    }

    _getBgmBus(ctx) {
      if (!this.bgmGain) {
        this.bgmGain = ctx.createGain();
        this.bgmGain.gain.value = 0.28;
        this.bgmGain.connect(ctx.destination);
      }
      return this.bgmGain;
    }

    stopMusic() {
      for (const n of this.activeMusicNodes) {
        try { n.stop(); } catch (_) {}
      }
      this.activeMusicNodes = [];
    }

    // ==================== CEREBRAL STRATEGY BGM (112 BPM · D DORIAN) ====================
    startBGM() {
      if (!this.enabled || !this.bgmEnabled) return;
      const ctx = this._ensureCtx();
      if (!ctx) return;
      if (this.bgmRunning) return;

      const bus = this._getBgmBus(ctx);
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(Math.max(0.001, bus.gain.value), ctx.currentTime);
      bus.gain.linearRampToValueAtTime(0.28, ctx.currentTime + 0.45);

      this.bgmRunning = true;
      this.bgmNextTime = ctx.currentTime + 0.08;
      this._scheduleBgmLoop();
      this.bgmTimer = setInterval(() => this._scheduleBgmLoop(), 90);
    }

    stopBGM(fade = true) {
      this.bgmRunning = false;
      if (this.bgmTimer) {
        clearInterval(this.bgmTimer);
        this.bgmTimer = null;
      }
      if (this.ctx && this.bgmGain) {
        const now = this.ctx.currentTime;
        this.bgmGain.gain.cancelScheduledValues(now);
        if (fade) {
          this.bgmGain.gain.setValueAtTime(Math.max(0.0001, this.bgmGain.gain.value), now);
          this.bgmGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        } else {
          this.bgmGain.gain.setValueAtTime(0.0001, now);
        }
      }
    }

    setBGMEnabled(on) {
      this.bgmEnabled = Boolean(on);
      if (!this.bgmEnabled) this.stopBGM(true);
      else if (this.enabled) this.startBGM();
    }

    _scheduleBgmLoop() {
      if (!this.bgmRunning || !this.enabled || !this.bgmEnabled || !this.ctx) {
        this.stopBGM(false);
        return;
      }
      const stepSec = 60 / 112 / 4; // 112 BPM 16th-note pulse (~0.1339s)
      const lookahead = 0.24;

      while (this.bgmNextTime < this.ctx.currentTime + lookahead) {
        this._playBgmStep(this.bgmStep, this.bgmNextTime, stepSec);
        this.bgmNextTime += stepSec;
        this.bgmStep = (this.bgmStep + 1) % 128; // 8-bar evolving cycle (8 * 16 = 128 steps)
      }
    }

    _playBgmStep(step, t, stepSec) {
      const ctx = this.ctx;
      const bus = this._getBgmBus(ctx);
      const bar = Math.floor(step / 16); // 0..7
      const sub = step % 16;             // 0..15

      // 8-bar intellectual harmony: Dm9 -> Bbmaj7 -> C6/9 -> Asus4/A7 -> Dm9 -> Gm9 -> C9 -> A7sus4
      const PROG = [
        { bass: 73.42,  arp: [293.66, 349.23, 440.00, 523.25, 659.25, 523.25, 440.00, 349.23], pad: [293.66, 349.23, 440.00, 659.25] }, // Dm9
        { bass: 58.27,  arp: [233.08, 293.66, 349.23, 440.00, 587.33, 440.00, 349.23, 293.66], pad: [233.08, 293.66, 349.23, 440.00] }, // Bbmaj7
        { bass: 65.41,  arp: [261.63, 329.63, 392.00, 440.00, 587.33, 440.00, 392.00, 329.63], pad: [261.63, 329.63, 392.00, 587.33] }, // C6/9
        { bass: 55.00,  arp: [220.00, 293.66, 329.63, 440.00, 554.37, 440.00, 329.63, 277.18], pad: [220.00, 293.66, 329.63, 440.00] }, // A7sus4->A7
        { bass: 73.42,  arp: [293.66, 440.00, 523.25, 659.25, 587.33, 523.25, 440.00, 349.23], pad: [293.66, 349.23, 523.25, 659.25] }, // Dm9 (lift)
        { bass: 98.00,  arp: [392.00, 466.16, 587.33, 659.25, 587.33, 466.16, 392.00, 349.23], pad: [196.00, 293.66, 349.23, 466.16] }, // Gm9
        { bass: 65.41,  arp: [261.63, 329.63, 392.00, 523.25, 587.33, 523.25, 392.00, 329.63], pad: [261.63, 329.63, 466.16, 587.33] }, // C9
        { bass: 55.00,  arp: [220.00, 329.63, 392.00, 440.00, 554.37, 659.25, 554.37, 440.00], pad: [220.00, 277.18, 329.63, 440.00] }  // A7 tension
      ];
      const ch = PROG[bar];

      // 1. Syncopated Glass-Marimba / Rhodes Brainwave Pluck (plays on intriguing rhythmic mask)
      const arpMask = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1];
      if (arpMask[sub]) {
        const noteFreq = ch.arp[(Math.floor(sub / 2) + (bar >= 4 ? 1 : 0)) % ch.arp.length];
        const accent = (sub === 0 || sub === 6 || sub === 10) ? 1.0 : 0.68;
        this._bgmPluck(ctx, bus, noteFreq, t, stepSec * 2.1, 0.14 * accent);
      }

      // 2. Subtle Counter-Melody Bell Sparkle on Bars 4..7 (keeps brain engaged!)
      if (bar >= 4 && (sub === 4 || sub === 12)) {
        const bellFreq = ch.arp[sub === 4 ? 4 : 6] * 2;
        this._bgmPluck(ctx, bus, bellFreq, t, stepSec * 3.4, 0.055);
      }

      // 3. Warm Syncopated Sub-Bass Pulse (beats 1, 2.5, 4)
      if (sub === 0 || sub === 6 || sub === 12) {
        const f = (sub === 12) ? ch.bass * 1.5 : ch.bass; // 5th lift on beat 4
        const dur = (sub === 0) ? stepSec * 4.5 : stepSec * 2.6;
        this._bgmBass(ctx, bus, f, t, dur, sub === 0 ? 0.24 : 0.16);
      }

      // 4. Crisp Clockwork / Pizzicato Ticking Pulse (mental focus rhythm)
      if (sub % 2 === 0) {
        const isDown = (sub % 4 === 0);
        this._bgmTick(ctx, bus, t, isDown ? 1320 : 1980, isDown ? 0.048 : 0.026);
      }

      // 5. Lush Warm Glass Pad Swell on start of each bar
      if (sub === 0) {
        for (const f of ch.pad) {
          this._bgmPad(ctx, bus, f, t, stepSec * 15.6, 0.036);
        }
      }
    }

    _bgmPluck(ctx, bus, freq, t, dur, peak) {
      const osc = ctx.createOscillator();
      const overtone = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      overtone.type = 'sine';
      overtone.frequency.setValueAtTime(freq * 2, t);

      const ovGain = ctx.createGain();
      ovGain.gain.setValueAtTime(0.22, t);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2200, t);
      filter.frequency.exponentialRampToValueAtTime(520, t + dur);

      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.linearRampToValueAtTime(peak, t + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(filter);
      overtone.connect(ovGain);
      ovGain.connect(filter);
      filter.connect(amp);
      amp.connect(bus);

      osc.start(t);
      overtone.start(t);
      osc.stop(t + dur + 0.02);
      overtone.stop(t + dur + 0.02);
    }

    _bgmBass(ctx, bus, freq, t, dur, peak) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(260, t);

      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.linearRampToValueAtTime(peak, t + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(filter);
      filter.connect(amp);
      amp.connect(bus);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }

    _bgmTick(ctx, bus, t, freq, peak) {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.45, t + 0.028);
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.linearRampToValueAtTime(peak, t + 0.003);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.032);
      osc.connect(amp);
      amp.connect(bus);
      osc.start(t);
      osc.stop(t + 0.04);
    }

    _bgmPad(ctx, bus, freq, t, dur, peak) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(950, t);

      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.linearRampToValueAtTime(peak, t + 0.35);
      amp.gain.setValueAtTime(peak * 0.8, t + dur - 0.45);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(filter);
      filter.connect(amp);
      amp.connect(bus);
      osc.start(t);
      osc.stop(t + dur + 0.04);
    }

    _tone(freq, duration, type = 'sine', gain = 0.14, delay = 0, freqEnd = null, dest = null) {
      const ctx = this._ensureCtx();
      if (!ctx) return null;
      const now = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (freqEnd !== null) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + duration);
      }
      amp.gain.setValueAtTime(0.0001, now);
      amp.gain.linearRampToValueAtTime(gain, now + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(amp);
      amp.connect(dest || ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.03);
      return osc;
    }

    // Filtered warm brass/pad voice for rich music chords
    _musicVoice(freq, startDelay, duration, options = {}) {
      const ctx = this._ensureCtx();
      if (!ctx) return;
      const bus = this._getMusicBus(ctx);
      const now = ctx.currentTime + startDelay;

      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();

      osc.type = options.type || 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);
      if (options.detune) osc.detune.setValueAtTime(options.detune, now);
      if (options.freqEnd) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.freqEnd), now + duration);
      }

      filter.type = options.filterType || 'lowpass';
      filter.frequency.setValueAtTime(options.cutoffStart || 1400, now);
      if (options.cutoffEnd) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(80, options.cutoffEnd), now + duration);
      }
      filter.Q.value = options.q || 1.2;

      const peak = options.gain || 0.12;
      const attack = options.attack || 0.04;
      const release = Math.min(duration * 0.65, options.release || 0.35);

      amp.gain.setValueAtTime(0.0001, now);
      amp.gain.linearRampToValueAtTime(peak, now + attack);
      amp.gain.setValueAtTime(peak * 0.85, now + Math.max(attack, duration - release));
      amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(filter);
      filter.connect(amp);
      amp.connect(bus);

      osc.start(now);
      osc.stop(now + duration + 0.05);
      this.activeMusicNodes.push(osc);
    }

    // Filtered noise burst (for timpani snap / Souls-like dark ash whoosh)
    _noiseWhoosh(startDelay, duration, cutoffStart, cutoffEnd, gain = 0.14) {
      const ctx = this._ensureCtx();
      if (!ctx) return;
      const bus = this._getMusicBus(ctx);
      const bufferSize = Math.floor(ctx.sampleRate * duration);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const now = ctx.currentTime + startDelay;
      const src = ctx.createBufferSource();
      src.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(cutoffStart, now);
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, cutoffEnd), now + duration);
      filter.Q.value = 1.4;

      const amp = ctx.createGain();
      amp.gain.setValueAtTime(0.0001, now);
      amp.gain.linearRampToValueAtTime(gain, now + 0.08);
      amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      src.connect(filter);
      filter.connect(amp);
      amp.connect(bus);
      src.start(now);
      src.stop(now + duration + 0.04);
      this.activeMusicNodes.push(src);
    }

    // ==================== GAMEPLAY SFX ====================
    select() {
      this._tone(520, 0.07, 'triangle', 0.09, 0, 640);
    }

    place() {
      this._tone(310, 0.09, 'triangle', 0.14, 0, 190);
      this._tone(620, 0.05, 'sine', 0.06, 0.015);
    }

    move() {
      this._tone(380, 0.08, 'sine', 0.11, 0, 480);
    }

    wall() {
      this._tone(165, 0.14, 'triangle', 0.22, 0, 62);
      this._tone(420, 0.06, 'square', 0.05, 0, 180);
    }

    hammer() {
      this._tone(240, 0.18, 'sawtooth', 0.18, 0, 55);
      this._tone(880, 0.09, 'triangle', 0.10, 0.02, 220);
      this._tone(620, 0.11, 'square', 0.07, 0.05, 140);
    }

    territoryLock() {
      this._tone(523.25, 0.16, 'sine', 0.09, 0);
      this._tone(659.25, 0.2, 'sine', 0.09, 0.07);
    }

    // ==================== COUNTDOWN TENSION AUDIO ====================
    countdownTick(sec) {
      if (!this.enabled) return;
      if (sec > 5) {
        // 10s..6s: crisp mechanical timepiece tick
        this._tone(740, 0.04, 'triangle', 0.065, 0, 520);
        return;
      }

      // 5s..1s: intense game-show tension — rising metallic tick + heartbeat sub-bass + suspense pulse
      const urgency = 6 - sec; // 1 (at 5s) -> 5 (at 1s)
      const pitch = 780 + urgency * 95;
      // Sharp clock strike
      this._tone(pitch, 0.075, 'triangle', 0.13 + urgency * 0.012, 0, pitch * 0.82);
      this._tone(pitch * 1.5, 0.04, 'sine', 0.05, 0.005);

      // Deep cinematic heartbeat double-thump
      this._tone(82, 0.16, 'sine', 0.24, 0, 38);
      this._tone(68, 0.14, 'sine', 0.15, 0.22, 34);

      // Low suspense synth stab (rising minor tension)
      const tensionRoots = [146.83, 155.56, 164.81, 174.61, 196.0]; // D3 -> Eb3 -> E3 -> F3 -> G3
      const root = tensionRoots[Math.min(tensionRoots.length - 1, urgency - 1)];
      this._musicVoice(root, 0, 0.34, {
        type: 'sawtooth',
        cutoffStart: 520 + urgency * 140,
        cutoffEnd: 180,
        gain: 0.065,
        attack: 0.015,
        release: 0.25
      });
    }

    tick(urgent = false) {
      this.countdownTick(urgent ? 3 : 6);
    }

    timeout() {
      this._tone(280, 0.15, 'sawtooth', 0.16, 0, 175);
      this._tone(210, 0.28, 'sawtooth', 0.16, 0.16, 120);
      this._tone(90, 0.32, 'sine', 0.2, 0, 42);
    }

    // ==================== VICTORY CELEBRATION FANFARE MUSIC ====================
    victoryMusic() {
      if (!this.enabled) return;
      this.stopBGM(true);
      this.stopMusic();

      // Triumphant brass & chime melody in C Major (approx 4.6s)
      const melody = [
        { f: 523.25, t: 0.00, d: 0.18 }, // C5
        { f: 659.25, t: 0.16, d: 0.18 }, // E5
        { f: 783.99, t: 0.32, d: 0.22 }, // G5
        { f: 1046.50, t: 0.54, d: 0.48 }, // C6 (heroic peak)
        { f: 880.00, t: 1.04, d: 0.18 }, // A5
        { f: 987.77, t: 1.22, d: 0.18 }, // B5
        { f: 1046.50, t: 1.42, d: 0.38 }, // C6
        { f: 1174.66, t: 1.82, d: 0.26 }, // D6
        { f: 1318.51, t: 2.10, d: 1.85 }  // E6 soaring finale
      ];

      for (const n of melody) {
        // Warm brass lead
        this._musicVoice(n.f, n.t, n.d + 0.15, {
          type: 'sawtooth',
          cutoffStart: 2400,
          cutoffEnd: 950,
          gain: 0.095,
          attack: 0.025,
          release: 0.3
        });
        // Sparkling bell harmonic shimmer
        this._musicVoice(n.f * 2, n.t, n.d + 0.25, {
          type: 'triangle',
          cutoffStart: 4200,
          cutoffEnd: 1800,
          gain: 0.045,
          attack: 0.01,
          release: 0.35
        });
      }

      // Celebratory lush chord pads
      const chords = [
        { notes: [261.63, 329.63, 392.00], t: 0.00, d: 1.00 }, // C major
        { notes: [220.00, 261.63, 329.63], t: 1.02, d: 0.78 }, // Am7
        { notes: [196.00, 246.94, 293.66], t: 1.80, d: 0.32 }, // G
        { notes: [130.81, 261.63, 329.63, 392.00, 493.88, 587.33], t: 2.10, d: 2.40 } // Grand Cmaj9 finale
      ];
      for (const ch of chords) {
        for (const freq of ch.notes) {
          this._musicVoice(freq, ch.t, ch.d, {
            type: 'triangle',
            cutoffStart: 1600,
            cutoffEnd: 620,
            gain: 0.06,
            attack: 0.06,
            release: 0.75
          });
        }
      }

      // Celebratory timpani hits
      this._tone(130.81, 0.35, 'sine', 0.22, 0.00, 65);
      this._tone(130.81, 0.32, 'sine', 0.20, 0.54, 65);
      this._tone(196.00, 0.25, 'sine', 0.18, 1.82, 98);
      this._tone(130.81, 0.75, 'sine', 0.28, 2.10, 55);
    }

    win() {
      this.victoryMusic();
    }

    // ==================== SOULS-LIKE TRAGIC DEFEAT AUDIO ("YOU LOSE") ====================
    soulsDefeat() {
      if (!this.enabled) return;
      this.stopBGM(true);
      this.stopMusic();

      // 1. Massive iconic deep funeral boom / impact
      this._tone(96, 1.35, 'sine', 0.36, 0, 26);
      this._tone(58, 2.10, 'triangle', 0.24, 0.02, 24);
      this._noiseWhoosh(0.0, 2.4, 920, 140, 0.20);

      // 2. Haunting metallic cathedral bell / gong toll (inharmonic overtones)
      const bellPartials = [
        { f: 146.83, g: 0.14, d: 3.8 },  // D3
        { f: 220.00, g: 0.10, d: 3.4 },  // A3
        { f: 277.18, g: 0.065, d: 2.8 }, // C#4 (tragic dissonance)
        { f: 349.23, g: 0.075, d: 3.2 }, // F4 (D minor third)
        { f: 418.00, g: 0.04, d: 2.2 }   // Metallic bell overtone
      ];
      for (const b of bellPartials) {
        this._musicVoice(b.f, 0.03, b.d, {
          type: 'triangle',
          cutoffStart: 1200,
          cutoffEnd: 240,
          gain: b.g,
          attack: 0.02,
          release: b.d * 0.82
        });
      }

      // 3. Slow tragic dark-organ / strings swell (D minor -> Bb/D -> hollow D5 fade)
      const darkPad1 = [73.42, 110.00, 146.83, 174.61]; // D2, A2, D3, F3
      for (const f of darkPad1) {
        this._musicVoice(f, 0.25, 2.5, {
          type: 'sawtooth',
          detune: -6,
          cutoffStart: 580,
          cutoffEnd: 210,
          gain: 0.072,
          attack: 0.45,
          release: 1.4
        });
      }

      // Second mournful descending sigh (C#3 -> C3 / A2 hollow resolution)
      const darkPad2 = [65.41, 110.00, 138.59, 164.81];
      for (const f of darkPad2) {
        this._musicVoice(f, 1.9, 2.7, {
          type: 'sawtooth',
          detune: 5,
          cutoffStart: 420,
          cutoffEnd: 130,
          gain: 0.058,
          attack: 0.55,
          release: 1.7
        });
      }
    }
  }

  global.SoundFX = new SoundFX();
})(window);
