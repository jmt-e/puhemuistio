// AudioWorklet: turns microphone audio into 16 kHz mono 16-bit PCM, the
// format Whisper wants, and reports the input level for the meter.
//
// The AudioContext runs at whatever rate the phone's hardware uses (usually
// 48 kHz), and this resamples with a windowed-sinc low-pass filter. Asking
// Safari for a 16 kHz AudioContext instead has a history of distorted
// microphone audio on iOS, so we don't rely on it.

const OUT_RATE = 16000;
const POST_EVERY = 4000; // samples at 16 kHz = 250 ms
const LEVEL_EVERY = 0.05; // seconds

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capturing = false;
    this.ratio = sampleRate / OUT_RATE;
    this.passthrough = sampleRate === OUT_RATE;

    // Filter: cutoff a little under the 8 kHz Nyquist of the output.
    this.half = Math.ceil(8 * this.ratio); // taps on each side, in input samples
    this.fc = (2 * 7200) / sampleRate;

    this.inBuf = new Float32Array(0); // unconsumed input incl. history
    this.inStart = 0; // absolute input index of inBuf[0]
    this.nextOut = 0; // absolute output index of the next sample to produce

    this.out = new Int16Array(POST_EVERY);
    this.outLen = 0;

    this.levelPeak = 0;
    this.levelFrames = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'capture') {
        this.capturing = msg.on;
        if (!msg.on) this.flush();
      } else if (msg.type === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed', id: msg.id });
      }
    };
  }

  kernel(d) {
    // Low-pass sinc with a Blackman window, d in input samples. Looked up
    // from a precomputed table: trig per tap is too slow on the audio thread.
    if (!this.table) {
      const res = (this.res = 256);
      this.table = new Float32Array(this.half * res + 2);
      for (let i = 0; i < this.table.length; i++) {
        const x = i / res;
        if (x >= this.half) break;
        const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / this.half) + 0.08 * Math.cos((2 * Math.PI * x) / this.half);
        const a = Math.PI * this.fc * x;
        this.table[i] = (x === 0 ? this.fc : (this.fc * Math.sin(a)) / a) * w;
      }
    }
    const p = Math.abs(d) * this.res;
    const i = Math.floor(p);
    if (i + 1 >= this.table.length) return 0;
    const f = p - i;
    return this.table[i] * (1 - f) + this.table[i + 1] * f;
  }

  emit(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.outLen === POST_EVERY) this.flush();
  }

  flush() {
    if (this.outLen === 0) return;
    const chunk = this.out.slice(0, this.outLen);
    this.outLen = 0;
    this.port.postMessage({ type: 'data', pcm: chunk }, [chunk.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Mix down to mono.
    const n = input[0].length;
    const mono = new Float32Array(n);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
    }

    // Level meter (RMS of this block), even while not capturing so the
    // meter shows the mic is alive before recording starts.
    let sum = 0;
    for (let i = 0; i < n; i++) sum += mono[i] * mono[i];
    this.levelPeak = Math.max(this.levelPeak, Math.sqrt(sum / n));
    this.levelFrames += n;
    if (this.levelFrames >= LEVEL_EVERY * sampleRate) {
      this.port.postMessage({ type: 'level', value: this.levelPeak });
      this.levelPeak = 0;
      this.levelFrames = 0;
    }

    if (!this.capturing) {
      // Drop audio while paused, and restart the resampler cleanly.
      this.inBuf = new Float32Array(0);
      this.inStart = 0;
      this.nextOut = 0;
      return true;
    }

    if (this.passthrough) {
      for (let i = 0; i < n; i++) this.emit(mono[i]);
      return true;
    }

    // Append to the input buffer.
    const buf = new Float32Array(this.inBuf.length + n);
    buf.set(this.inBuf, 0);
    buf.set(mono, this.inBuf.length);
    this.inBuf = buf;
    const inEnd = this.inStart + buf.length; // absolute index one past the last input sample

    // Produce every output sample whose filter window is fully available.
    for (;;) {
      const t = this.nextOut * this.ratio; // position in input samples
      const center = Math.floor(t);
      if (center + this.half >= inEnd) break;
      let acc = 0;
      const lo = Math.max(this.inStart, center - this.half + 1);
      for (let k = lo; k <= center + this.half; k++) {
        acc += buf[k - this.inStart] * this.kernel(t - k);
      }
      this.emit(acc);
      this.nextOut++;
    }

    // Keep only what future output samples still need.
    const need = Math.floor(this.nextOut * this.ratio) - this.half;
    if (need > this.inStart) {
      this.inBuf = buf.slice(need - this.inStart);
      this.inStart = need;
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
