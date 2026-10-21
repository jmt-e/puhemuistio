// Microphone recording with pause/continue, saved to IndexedDB every second.
//
// Audio never leaves the phone: it goes mic -> AudioWorklet (16 kHz PCM) ->
// IndexedDB. A recording is a "draft" until Stop, so a screen lock, a phone
// call, an app switch or even Safari reloading the page keeps what was
// recorded; the app offers to continue it on return.

import * as db from './db.js';

export const SAMPLE_RATE = 16000;
export const MAX_SECONDS = 5 * 60;
const SAVE_EVERY_MS = 1000;

export class MicError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // 'denied' | 'nomic' | 'insecure' | 'unsupported' | 'other'
    this.cause = cause;
  }
}

/**
 * Events (CustomEvent.detail):
 *   state  'recording' | 'paused' | 'idle'
 *   level  0..1 RMS
 *   time   seconds recorded
 *   paused reason string when the app paused on its own (background, call, limit)
 */
export class Recorder extends EventTarget {
  constructor() {
    super();
    this.state = 'idle';
    this.draft = null;
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.pending = [];
    this.pendingSamples = 0;
    this.seq = 0;
    this.saving = Promise.resolve();
    this.saveTimer = null;
    this.wakeLock = null;
    this.flushWaiters = new Map();
    this.onVisibility = () => {
      if (document.visibilityState === 'hidden' && this.state === 'recording') {
        this.pause('background');
      }
    };
  }

  get seconds() {
    if (!this.draft) return 0;
    return (this.draft.samples + this.pendingSamples) / SAMPLE_RATE;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(s) {
    this.state = s;
    this.emit('state', s);
  }

  /** Start a new recording. noteId set = add to that note. */
  async start({ noteId = null, title = '', language = 'fi' }) {
    await this.openMic();
    this.draft = {
      id: db.newId(),
      noteId,
      title,
      language,
      createdAt: Date.now(),
      samples: 0,
    };
    this.seq = 0;
    await db.saveDraft(this.draft);
    this.beginCapture();
  }

  /** Re-attach to a draft found after a reload; starts in the paused state. */
  async adopt(draft) {
    this.draft = draft;
    const audio = await db.getDraftAudio(draft.id);
    draft.samples = audio.length;
    this.seq = Date.now(); // any value above the old seqs keeps order
    this.setState('paused');
    this.emit('time', this.seconds);
  }

  async continue() {
    if (this.state !== 'paused') return;
    if (this.seconds >= MAX_SECONDS) return;
    await this.openMic();
    this.beginCapture();
  }

  async pause(reason = null) {
    if (this.state !== 'recording') return;
    this.setState('paused');
    this.node?.port.postMessage({ type: 'capture', on: false });
    await this.flushWorklet();
    await this.save();
    this.releaseWakeLock();
    // Free the microphone while paused, so iOS's orange dot goes away and
    // a phone call can't break a mic we're holding. Continue reopens it.
    this.closeMic();
    if (reason) this.emit('paused', reason);
  }

  /** Finish: returns the draft (all audio saved), ready for db.commitDraft. */
  async stop() {
    if (this.state === 'recording') {
      this.node?.port.postMessage({ type: 'capture', on: false });
      await this.flushWorklet();
    }
    await this.save();
    this.releaseWakeLock();
    this.closeMic();
    const draft = this.draft;
    this.draft = null;
    this.setState('idle');
    return draft;
  }

  async discard() {
    const draft = await this.stop();
    if (draft) await db.deleteDraft(draft.id);
  }

  // ---------- internals ----------

  async openMic() {
    if (!window.isSecureContext) throw new MicError('insecure');
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new MicError('unsupported');

    if (this.stream && this.stream.getAudioTracks().every((t) => t.readyState === 'live') && this.ctx?.state === 'running') {
      return;
    }
    this.closeMic();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw new MicError('denied', err);
      if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') throw new MicError('nomic', err);
      throw new MicError('other', err);
    }

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e) => this.onWorklet(e.data);
    source.connect(this.node);
    if (this.ctx.state !== 'running') await this.ctx.resume();

    // A phone call or Siri takes the mic: the track ends or mutes, or iOS
    // marks the AudioContext "interrupted". Pause and keep what we have.
    for (const t of this.stream.getAudioTracks()) {
      t.onended = () => this.pause('interrupted');
      t.onmute = () => this.pause('interrupted');
    }
    this.ctx.onstatechange = () => {
      if (this.ctx && this.ctx.state !== 'running') this.pause('interrupted');
    };
  }

  closeMic() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        t.onended = null;
        t.onmute = null;
        t.stop();
      }
    }
    if (this.ctx) {
      this.ctx.onstatechange = null;
      this.ctx.close().catch(() => {});
    }
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.emit('level', 0);
  }

  beginCapture() {
    this.node.port.postMessage({ type: 'capture', on: true });
    this.setState('recording');
    this.requestWakeLock();
    document.addEventListener('visibilitychange', this.onVisibility);
    clearInterval(this.saveTimer);
    this.saveTimer = setInterval(() => this.save(), SAVE_EVERY_MS);
  }

  onWorklet(msg) {
    if (msg.type === 'level') {
      this.emit('level', msg.value);
    } else if (msg.type === 'data') {
      if (!this.draft) return;
      this.pending.push(msg.pcm);
      this.pendingSamples += msg.pcm.length;
      this.emit('time', this.seconds);
      if (this.seconds >= MAX_SECONDS && this.state === 'recording') {
        this.pause('limit');
      }
    } else if (msg.type === 'flushed') {
      this.flushWaiters.get(msg.id)?.();
      this.flushWaiters.delete(msg.id);
    }
  }

  flushWorklet() {
    if (!this.node) return Promise.resolve();
    const id = Math.random();
    return new Promise((resolve) => {
      this.flushWaiters.set(id, resolve);
      this.node.port.postMessage({ type: 'flush', id });
      // Never hang if the audio thread is already gone.
      setTimeout(resolve, 500);
    });
  }

  /** Write buffered audio to IndexedDB. Serialised so chunks stay in order. */
  save() {
    if (this.state !== 'recording') {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    this.saving = this.saving.then(async () => {
      if (!this.draft || this.pending.length === 0) return;
      const parts = this.pending;
      const n = this.pendingSamples;
      this.pending = [];
      this.pendingSamples = 0;
      const pcm = new Int16Array(n);
      let off = 0;
      for (const p of parts) { pcm.set(p, off); off += p.length; }
      this.draft.samples += n;
      try {
        await db.appendChunk(this.draft, this.seq++, pcm);
      } catch (err) {
        // Put it back and retry on the next tick rather than lose audio.
        this.draft.samples -= n;
        this.pending.unshift(pcm);
        this.pendingSamples += n;
        console.error('Saving audio failed', err);
      }
    });
    return this.saving;
  }

  async requestWakeLock() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      this.wakeLock = null; // Not supported or not allowed: recording still works.
    }
  }

  releaseWakeLock() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}

// ---------- PCM helpers ----------

export function int16ToFloat32(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

/** A WAV file of 16 kHz mono 16-bit PCM, for playback and backups. */
export function pcmToWav(pcm) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}
