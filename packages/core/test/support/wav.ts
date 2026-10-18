// Synthetic WAV files for tests: no audio fixtures to store, and the music steps of the web package use them too.
// Plain bytes in, plain bytes out; nothing here depends on the test runner.

export type WavEncoding = {
  sampleRate: number;
  bits: 16 | 24 | 32;
  // IEEE float samples instead of integers (32 bits only).
  float?: boolean;
  // WAVE_FORMAT_EXTENSIBLE header, as written by most modern encoders.
  extensible?: boolean;
};

const EXTENSIBLE_TAG = 0xfffe;
// KSDATAFORMAT_SUBTYPE_xxx: the format code, then the fixed tail of the GUID.
const SUBFORMAT_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

// Interleaves one signal per channel (samples in -1..1) into a WAV file.
export const encodeWav = (channelData: readonly Float32Array[], { sampleRate, bits, float = false, extensible = false }: WavEncoding): Uint8Array => {
  const first = channelData[0];
  if (first === undefined) throw new Error('a WAV needs at least one channel');
  if (float && bits !== 32) throw new Error('float samples are 32 bits');
  const channels = channelData.length;
  const frames = first.length;
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const formatCode = float ? 3 : 1;
  const fmtSize = extensible ? 40 : 16;
  const padding = dataBytes % 2;
  const out = new Uint8Array(12 + 8 + fmtSize + 8 + dataBytes + padding);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));

  tag(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? EXTENSIBLE_TAG : formatCode, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true); // size of the extension
    view.setUint16(38, bits, true); // valid bits per sample
    view.setUint32(40, (1 << channels) - 1, true); // speaker mask
    view.setUint16(44, formatCode, true);
    SUBFORMAT_TAIL.forEach((byte, i) => view.setUint8(46 + i, byte));
  }
  const dataAt = 20 + fmtSize;
  tag(dataAt, 'data');
  view.setUint32(dataAt + 4, dataBytes, true);

  const peak = 2 ** (bits - 1);
  let at = dataAt + 8;
  for (let frame = 0; frame < frames; frame++) {
    for (const samples of channelData) {
      const x = Math.max(-1, Math.min(1, samples[frame] ?? 0));
      if (float) view.setFloat32(at, x, true);
      else if (bits === 16) view.setInt16(at, Math.round(x * (peak - 1)), true);
      else if (bits === 32) view.setInt32(at, Math.round(x * (peak - 1)), true);
      else {
        // 24 bits, little endian two's complement.
        const value = Math.round(x * (peak - 1));
        view.setUint8(at, value & 0xff);
        view.setUint8(at + 1, (value >> 8) & 0xff);
        view.setUint8(at + 2, (value >> 16) & 0xff);
      }
      at += bytesPerSample;
    }
  }
  return out;
};

export type ClickWavOptions = Partial<Omit<WavEncoding, 'sampleRate'>> & {
  bpm: number;
  seconds: number;
  // Time of the first click, in seconds.
  offset: number;
  // Peak level of each click, in dBFS.
  gainDb: number;
  sampleRate?: number;
  channels?: number;
  // How long a click rings. Shorter than a beat. The default, 10 ms, is a tick: enough for a beat tracker, but the
  // level of the first quarter second after the beat (TrackMeasure.startRmsDb) is then far below the peak, or silent.
  // A track that has to read as music loud enough to pass chooseTrack needs longer hits, say 0.25.
  clickSeconds?: number;
};

const CLICK_HZ = 1000;
const ATTACK_SECONDS = 0.001;

// A click track: on every beat, a burst of a 1 kHz tone that starts within a millisecond and dies away
// over `clickSeconds`. Its peak is exactly `gainDb`. The same signal goes to every channel.
export const clickWav = ({
  bpm,
  seconds,
  offset,
  gainDb,
  clickSeconds = 0.01,
  sampleRate = 44100,
  bits = 16,
  channels = 2,
  float,
  extensible,
}: ClickWavOptions): Uint8Array => {
  const length = Math.round(clickSeconds * sampleRate);
  const attack = Math.max(1, Math.round(ATTACK_SECONDS * sampleRate));
  const burst = Float32Array.from(
    { length },
    (_, i) => Math.min(1, i / attack) * Math.exp((-5 * i) / length) * Math.sin((2 * Math.PI * CLICK_HZ * i) / sampleRate),
  );
  const scale = 10 ** (gainDb / 20) / burst.reduce((peak, x) => Math.max(peak, Math.abs(x)), 0);

  const signal = new Float32Array(Math.round(seconds * sampleRate));
  for (let beat = 0; ; beat++) {
    const start = Math.round((offset + (beat * 60) / bpm) * sampleRate);
    if (start >= signal.length) break;
    burst.forEach((x, i) => {
      if (start + i < signal.length) signal[start + i] = x * scale;
    });
  }
  return encodeWav(Array.from({ length: channels }, () => signal), { sampleRate, bits, float, extensible });
};
