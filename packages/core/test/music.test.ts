import MusicTempo from 'music-tempo';
import { describe, expect, it } from 'vitest';
import { EdlSchema, MAX_TRACK_SHORT_FALL_SECONDS, chooseTrack, layoutScenes, measureTrack, musicPrompt, parseWav, trackCoversVideo, type TrackMeasure } from '../src/index';
import edlShopJson from './fixtures/edl-shop.json';
import { clickWav, encodeWav } from './support/wav';

const edlShop = EdlSchema.parse(edlShopJson);

const peakOf = (samples: Float32Array) => samples.reduce((peak, x) => Math.max(peak, Math.abs(x)), 0);
const bytesOf = (text: string) => [...text].map((c) => c.charCodeAt(0));
// The same file with one more chunk right after the `fmt ` chunk (which is 24 bytes after the 12-byte header).
const withChunkAfterFmt = (wav: Uint8Array, id: string, payload: number[]): Uint8Array => {
  const size = [payload.length & 0xff, (payload.length >> 8) & 0xff, 0, 0];
  const pad = payload.length % 2 === 1 ? [0] : [];
  const chunk = [...bytesOf(id), ...size, ...payload, ...pad];
  const out = new Uint8Array(wav.length + chunk.length);
  out.set(wav.subarray(0, 36), 0);
  out.set(chunk, 36);
  out.set(wav.subarray(36), 36 + chunk.length);
  return out;
};

describe('parseWav', () => {
  it('parses 16-bit stereo', () => {
    const wav = parseWav(clickWav({ bpm: 120, seconds: 1, offset: 0, gainDb: -6 }));
    expect(wav.sampleRate).toBe(44100);
    expect(wav.channels).toBe(2);
    expect(wav.mono).toHaveLength(44100);
    expect(peakOf(wav.mono)).toBeCloseTo(10 ** (-6 / 20), 3);
  });

  it('parses float32 mono', () => {
    const wav = parseWav(clickWav({ bpm: 120, seconds: 2, offset: 0, gainDb: -12, bits: 32, float: true, channels: 1, sampleRate: 48000 }));
    expect(wav.sampleRate).toBe(48000);
    expect(wav.channels).toBe(1);
    expect(wav.mono).toHaveLength(2 * 48000);
    expect(peakOf(wav.mono)).toBeCloseTo(10 ** (-12 / 20), 5);
  });

  it.each([
    { name: '24-bit PCM', options: { bits: 24 as const } },
    { name: '32-bit PCM', options: { bits: 32 as const } },
    { name: 'extensible 16-bit PCM', options: { bits: 16 as const, extensible: true } },
    { name: 'extensible 24-bit PCM', options: { bits: 24 as const, extensible: true } },
    { name: 'extensible float32', options: { bits: 32 as const, float: true, extensible: true } },
  ])('parses $name at the same level', ({ options }) => {
    const wav = parseWav(clickWav({ bpm: 120, seconds: 1, offset: 0, gainDb: -6, ...options }));
    expect(wav.mono).toHaveLength(44100);
    expect(peakOf(wav.mono)).toBeCloseTo(10 ** (-6 / 20), 4);
  });

  it('averages the channels into the mono signal', () => {
    const left = Float32Array.of(0.5, 0.5, -0.25);
    const right = Float32Array.of(-0.5, 0.25, -0.25);
    const wav = parseWav(encodeWav([left, right], { sampleRate: 8000, bits: 32, float: true }));
    expect(Array.from(wav.mono)).toEqual([0, 0.375, -0.25]);
  });

  it('reads 24-bit samples with their sign', () => {
    const wav = parseWav(encodeWav([Float32Array.of(-0.5, 0.5)], { sampleRate: 8000, bits: 24 }));
    expect(wav.mono[0]).toBeCloseTo(-0.5, 5);
    expect(wav.mono[1]).toBeCloseTo(0.5, 5);
  });

  it('skips the chunks it does not know, even with an odd size', () => {
    const plain = clickWav({ bpm: 120, seconds: 1, offset: 0, gainDb: -6 });
    const wav = parseWav(withChunkAfterFmt(plain, 'LIST', bytesOf('INFOabc')));
    expect(wav.mono).toHaveLength(44100);
    expect(wav.mono).toEqual(parseWav(plain).mono);
  });

  it('keeps the audio of a file read from a view that does not start at zero', () => {
    const plain = clickWav({ bpm: 120, seconds: 1, offset: 0, gainDb: -6 });
    const shifted = new Uint8Array(plain.length + 5);
    shifted.set(plain, 5);
    expect(parseWav(shifted.subarray(5)).mono).toEqual(parseWav(plain).mono);
  });

  it('takes the audio that is there when the header promises more (streamed files)', () => {
    const wav = clickWav({ bpm: 120, seconds: 1, offset: 0, gainDb: -6 });
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true); // data size of an encoder that could not seek back
    expect(parseWav(wav).mono).toHaveLength(44100);
  });

  it('rejects a non-WAV buffer', () => expect(() => parseWav(new Uint8Array(8))).toThrow('not a WAV file'));
  it('rejects a RIFF file that is not a WAV', () =>
    expect(() => parseWav(Uint8Array.from([...bytesOf('RIFF'), 4, 0, 0, 0, ...bytesOf('AVI '), 0, 0, 0, 0]))).toThrow('not a WAV file'));

  it('rejects a WAV without a format chunk', () => {
    const wav = clickWav({ bpm: 120, seconds: 1, offset: 0, gainDb: -6 });
    wav.set(bytesOf('junk'), 12); // the format chunk becomes one that is skipped
    expect(() => parseWav(wav)).toThrow('WAV has no fmt chunk');
  });

  it('rejects a WAV without audio data', () => {
    const wav = clickWav({ bpm: 120, seconds: 1, offset: 0, gainDb: -6 });
    expect(() => parseWav(wav.subarray(0, 36))).toThrow('WAV has no data chunk');
  });

  it('rejects an encoding it cannot read', () => {
    const wav = clickWav({ bpm: 120, seconds: 1, offset: 0, gainDb: -6 });
    new DataView(wav.buffer).setUint16(20, 85, true); // MPEG layer 3
    expect(() => parseWav(wav)).toThrow('unsupported WAV encoding');
  });
});

describe('clickWav', () => {
  const click = (options: Partial<Parameters<typeof clickWav>[0]> = {}) =>
    parseWav(clickWav({ bpm: 120, seconds: 2, offset: 0.3, gainDb: -6, ...options })).mono;
  const firstSound = (samples: Float32Array) => samples.findIndex((x) => x !== 0);

  it('puts a click on every beat, the first one at the offset', () => {
    const mono = click();
    expect(firstSound(mono)).toBe(Math.round(0.3 * 44100) + 1); // the tone starts from zero
    for (const beat of [0, 1, 2, 3]) {
      const at = Math.round((0.3 + beat * 0.5) * 44100);
      expect(peakOf(mono.subarray(at, at + 441))).toBeGreaterThan(0.4);
    }
    expect(peakOf(mono.subarray(Math.round(0.3 * 44100) + 441, Math.round(0.8 * 44100)))).toBe(0); // silent between clicks
  });

  it('lets a click ring for as long as it is asked to', () => {
    const at = Math.round(0.3 * 44100);
    expect(peakOf(click().subarray(at + 1000, at + 22000))).toBe(0);
    expect(peakOf(click({ clickSeconds: 0.25 }).subarray(at + 1000, at + 5000))).toBeGreaterThan(0.01);
  });

  it('cuts the last click at the end of the track', () => expect(click({ seconds: 0.305 })).toHaveLength(Math.round(0.305 * 44100)));
});

describe('measureTrack', () => {
  const measure = (options: Parameters<typeof clickWav>[0], requestedBpm = 112, videoSeconds?: number) => {
    const wav = parseWav(clickWav(options));
    return measureTrack(wav.mono, wav.sampleRate, requestedBpm, videoSeconds);
  };

  it('measures a 120 bpm click track', () => {
    const m = measureTrack(parseWav(clickWav({ bpm: 120, seconds: 30, offset: 0.3, gainDb: -6 })).mono, 44100, 112);
    expect(m.measuredBpm).toBeCloseTo(120, 0);
    expect(m.firstBeat).toBeCloseTo(0.3, 1);
    expect(m.beatResidualMs).toBeLessThan(10);
    expect(m.seconds).toBe(30);
  });

  it('measures a track at another sample rate', () => {
    const m = measure({ bpm: 120, seconds: 30, offset: 0.3, gainDb: -6, sampleRate: 48000 });
    expect(m.measuredBpm).toBeCloseTo(120, 0);
    expect(m.firstBeat).toBeCloseTo(0.3, 1);
    expect(m.seconds).toBe(30);
  });

  it('measures a tempo that is not a whole number of samples per beat', () => {
    expect(measure({ bpm: 113.2, seconds: 30, offset: 0.1, gainDb: -6 }).measuredBpm).toBeCloseTo(113.2, 0);
  });

  it('folds half/double time to the octave nearest the request', () => {
    const track = { bpm: 120, seconds: 30, offset: 0.3, gainDb: -6 };
    expect(measure(track, 60).measuredBpm).toBeCloseTo(60, 0);
    expect(measure(track, 240).measuredBpm).toBeCloseTo(240, 0);
    expect(measure(track, 130).measuredBpm).toBeCloseTo(120, 0);
  });

  it('reports the levels in dBFS: 6 dB less gain is 6 dB less at the start and overall', () => {
    const loud = measure({ bpm: 120, seconds: 30, offset: 0.3, gainDb: -6, clickSeconds: 0.25 });
    const quiet = measure({ bpm: 120, seconds: 30, offset: 0.3, gainDb: -12, clickSeconds: 0.25 });
    expect(loud.startRmsDb).toBeGreaterThan(-30);
    expect(loud.startRmsDb).toBeLessThan(-6);
    expect(loud.startRmsDb - quiet.startRmsDb).toBeCloseTo(6, 0);
    expect(loud.energyDb - quiet.energyDb).toBeCloseTo(6, 0);
  });

  it('measures the energy over the length of the video, not the whole track', () => {
    // 10 s of clicks at -6 dB and then 20 s of clicks 20 dB lower.
    const wav = parseWav(clickWav({ bpm: 120, seconds: 30, offset: 0.3, gainDb: -6 }));
    wav.mono.subarray(10 * 44100).forEach((x, i, tail) => (tail[i] = x * 0.1));
    const wholeTrack = measureTrack(wav.mono, 44100, 112);
    const videoOnly = measureTrack(wav.mono, 44100, 112, 8);
    expect(videoOnly.energyDb).toBeGreaterThan(wholeTrack.energyDb + 3);
    expect(videoOnly.startRmsDb).toBe(wholeTrack.startRmsDb);
  });

  it('measures all of the track when the video is longer than it', () => {
    const track = { bpm: 120, seconds: 12, offset: 0.3, gainDb: -6 };
    expect(measure(track, 112, 60).energyDb).toBe(measure(track).energyDb);
  });

  it('refuses a track with no beat to find', () => {
    expect(() => measureTrack(new Float32Array(44100 * 10), 44100, 112)).toThrow('could not measure the tempo');
  });

  it('refuses a track that is too short to have a tempo', () => {
    const wav = parseWav(clickWav({ bpm: 120, seconds: 1, offset: 0.1, gainDb: -6 }));
    expect(() => measureTrack(wav.mono, 44100, 112)).toThrow('could not measure the tempo');
  });
});

// The shapes of the three Lyria tracks of the first production order (112 bpm asked, a 19.3 s video), built from clicks.
describe('measureTrack and chooseTrack on the openings Lyria writes', () => {
  const SAMPLE_RATE = 44100;
  const SECONDS = 30;
  const VIDEO_SECONDS = 19.3;
  // The tracks ran at 110 bpm; a 16th note is a quarter of a beat.
  const BEAT = 60 / 110;
  const SIXTEENTH = BEAT / 4;

  const silence = () => new Float32Array(SECONDS * SAMPLE_RATE);
  // Mixes the click that clickWav makes into `mono` at each of `times`. Hits of 0.25 s at -6 dB read as music.
  const addClicks = (mono: Float32Array, times: number[], { gainDb = -6, clickSeconds = 0.25 } = {}): Float32Array => {
    const click = parseWav(clickWav({ bpm: 60, seconds: clickSeconds, offset: 0, gainDb, clickSeconds, channels: 1 })).mono;
    for (const time of times) {
      const at = Math.round(time * SAMPLE_RATE);
      click.forEach((x, i) => {
        if (at + i < mono.length) mono[at + i] = (mono[at + i] ?? 0) + x;
      });
    }
    return mono;
  };
  // A beat every BEAT from `first` to the end of the track, each moved by `shift(beat number, time on the grid)`.
  const beats = (first: number, shift: (beat: number, time: number) => number = () => 0): number[] =>
    Array.from({ length: Math.ceil((SECONDS - first) / BEAT) }, (_, beat) => first + beat * BEAT + shift(beat, first + beat * BEAT));
  // A hit on the grid at `first`, then three beats a 16th early (an intro figure), then the grid again.
  const introFigure = (first: number) => beats(first, (beat) => (beat >= 1 && beat <= 3 ? -SIXTEENTH : 0));
  // `mono` as a Lyria track that skips once: `ms` ms of it cut out at `at` s, so everything after comes that much early,
  // or (a positive `ms`) the `ms` ms before `at` played twice, so everything after comes that much late. Made in the
  // silence between two hits, a splice leaves no seam of its own.
  const spliced = (mono: Float32Array, at: number, ms: number): Float32Array => {
    const cut = Math.round(at * SAMPLE_RATE);
    // Where the track goes on from after the splice: further on (cut out) or further back (played twice).
    const resume = cut - Math.round((ms / 1000) * SAMPLE_RATE);
    const out = new Float32Array(cut + mono.length - resume);
    out.set(mono.subarray(0, cut));
    out.set(mono.subarray(resume), cut);
    return out;
  };
  const measure = (mono: Float32Array, requestedBpm = 112) => measureTrack(mono, SAMPLE_RATE, requestedBpm, VIDEO_SECONDS);
  const verdict = (track: TrackMeasure, requestedBpm = 112) => chooseTrack([track], requestedBpm, VIDEO_SECONDS);

  // The time of beat `beat` of a grid that starts at FIRST, at `bpm` (the tempo of the tracks above if left out).
  const FIRST = 0.5;
  const beatAt = (beat: number, bpm = 110) => FIRST + (beat * 60) / bpm;
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
  // A track that opens on a soft count-in: ticks (gain -26 dB, about the softest a tracker still hears in a track this
  // plain) on the beats `ticks`, a 16th-note fill (gain -12 dB: a hit of its own, but 9 dB under the groove) on beat `fill`,
  // and the groove (gain -3 dB, hits of 0.25 s) from beat `groove`, all on the grid that starts at FIRST.
  const countIn = ({ ticks, fill, groove, bpm = 110 }: { ticks: number[]; fill: number; groove: number; bpm?: number }): Float32Array => {
    const mono = addClicks(silence(), range(groove, 40).map((beat) => beatAt(beat, bpm)), { gainDb: -3 });
    addClicks(mono, ticks.map((beat) => beatAt(beat, bpm)), { gainDb: -26, clickSeconds: 0.03 });
    for (let n = 0; n < 4; n++) addClicks(mono, [beatAt(fill, bpm) + (n * 15) / bpm], { gainDb: -12, clickSeconds: 0.1 });
    return mono;
  };

  it('leaves out of the fit the few beats the tracker took off the grid, and starts at the first hit (cand-3)', () => {
    const track = measure(addClicks(silence(), introFigure(0.5)));
    expect(track.beatResidualMs).toBeLessThan(10);
    expect(track.measuredBpm).toBeCloseTo(110, 1);
    expect(track.firstBeat).toBeCloseTo(0.5, 1);
    expect(track.startRmsDb).toBeGreaterThan(-30);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
    expect(track.droppedBeats).toBe(3);
  });

  it('counts a late start from the first sound, not from the start of the file', () => {
    // Lyria puts up to 2.2 s of digital silence before some tracks; the render skips it.
    const track = measure(addClicks(silence(), beats(2.5)));
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
    expect(track.firstBeat).toBeCloseTo(2.5, 1); // in the file, where the render cuts it
    expect(track.audioStart).toBeCloseTo(2.5, 2);
  });

  it('takes the third track of the order: an intro figure behind 2.2 s of silence', () => {
    const track = measure(addClicks(silence(), introFigure(2.2)));
    expect(track.measuredBpm).toBeCloseTo(110, 1);
    expect(track.firstBeat).toBeCloseTo(2.2, 1);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
  });

  it('does not open the video on a hit too soft to open it', () => {
    // The intro figure, but the hit on the grid before it is a 10 ms tick. The tick is no start (too soft), nor is the grid
    // beat after it (the figure's hits are off the grid): the start is the first strong hit on the grid, on beat 4.
    const mono = addClicks(silence(), introFigure(0.5).slice(1));
    addClicks(mono, [0.5], { clickSeconds: 0.01 });
    const track = measure(mono);
    expect(track.firstBeat).toBeCloseTo(0.5 + 4 * BEAT, 1);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
  });

  it('does not move the start back onto a beat where nothing starts, however loud it is there', () => {
    // A steady grid from 1 s, and a long tone that starts 0.2 s before the beat ahead of it: loud on that beat, but no
    // onset within 40 ms of it.
    const mono = addClicks(silence(), beats(1));
    addClicks(mono, [1 - BEAT - 0.2], { clickSeconds: 1 });
    const track = measure(mono);
    expect(track.firstBeat).toBeCloseTo(1, 1);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
  });

  it('still finds unsteady a groove whose pulse moves by a 16th between sections (cand-1)', () => {
    // A 16th early for 12 beats, then on the grid, then a 16th late from 21.9 s.
    const track = measure(addClicks(silence(), beats(0.3, (beat, time) => (beat < 12 ? -SIXTEENTH : time < 21.9 ? 0 : SIXTEENTH))));
    expect(track.beatResidualMs).toBeGreaterThan(30);
    expect(verdict(track).rejected).toEqual([{ index: 0, reason: 'unsteady' }]);
  });

  it('still finds unsteady a groove whose last beats move by a 16th: only how a track opens is forgiven', () => {
    // A 24 s video plays the beats from 21 s, which come a 16th late.
    const track = measureTrack(addClicks(silence(), beats(0.3, (_, time) => (time >= 21 ? SIXTEENTH : 0))), SAMPLE_RATE, 112, 24);
    expect(chooseTrack([track], 112, 24).rejected).toEqual([{ index: 0, reason: 'unsteady' }]);
  });

  it('starts the video on the groove after a count-in bar and a fill, not on the fill (cand-2)', () => {
    // Four ticks, a fill on the last beat of the bar, the groove on the next downbeat.
    const track = measure(countIn({ ticks: range(0, 4), fill: 3, groove: 4 }));
    // Beat 3 is the fill: a hit (-25 dB) that a plain -30 dB rule would open on, but 9 dB under the groove.
    expect(track.firstBeat).toBeCloseTo(beatAt(4), 1);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
    // The levels are the groove's own: those of the same groove with nothing before it.
    const groove = measure(addClicks(silence(), range(4, 40).map((beat) => beatAt(beat)), { gainDb: -3 }));
    expect(track.startRmsDb).toBeCloseTo(groove.startRmsDb, 0);
    expect(track.energyDb).toBeCloseTo(groove.energyDb, 1);
    expect(track.audioStart).toBeCloseTo(FIRST, 2);
  });

  it('leaves the start on the count-in when no groove comes within 8 beats of the first sound', () => {
    // Nine soft beats and a fill, and the groove on beat 10: nothing in the lead-in (beats 0 to 8, which ends half a beat
    // past beat 8, at 8.5) is both a hit and strong. The start stays on the first tick, so it is not a late start but a weak one.
    const track = measure(countIn({ ticks: range(0, 10), fill: 9, groove: 10 }));
    expect(track.firstBeat).toBeCloseTo(FIRST, 1);
    expect(verdict(track)).toEqual({ chosen: null, rejected: [{ index: 0, reason: 'weak-start' }] });
  });

  it('does not take a fill in the first 8 beats for the groove that comes 4 beats after it', () => {
    // The fill on beat 6 is a hit and the loudest thing in the lead-in (beats 0 to 8, edge at 8.5), but the groove on beat
    // 10 is 9 dB louder and the strong beats are told from the 4 beats past the edge too: the fill is not strong, and
    // nothing else is a hit.
    const track = measure(countIn({ ticks: [...range(0, 6), ...range(7, 10)], fill: 6, groove: 10 }));
    expect(track.firstBeat).toBeCloseTo(FIRST, 1);
    expect(verdict(track).rejected).toEqual([{ index: 0, reason: 'weak-start' }]);
  });

  it('takes the groove on the last beat of the first 8 beats', () => {
    const track = measure(countIn({ ticks: range(0, 6), fill: 6, groove: 7 }));
    expect(track.firstBeat).toBeCloseTo(beatAt(7), 1);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
  });

  it.each([96, 110, 120])('takes the groove on beat 8 of a two-bar count-in: %d bpm', (bpm) => {
    // The grid sits a few ms off the first sound, either way, so the edge of the lead-in is half a beat past beat 8.
    const track = measure(countIn({ ticks: range(0, 7), fill: 7, groove: 8, bpm }), bpm);
    expect(track.firstBeat).toBeCloseTo(beatAt(8, bpm), 1);
    expect(verdict(track, bpm)).toEqual({ chosen: 0, rejected: [] });
  });

  it.each([96, 110, 120])('leaves the start on the count-in when the groove is on beat 9: %d bpm', (bpm) => {
    // Beyond the lead-in, so nothing there is both a hit and strong: the start stays on the first tick (a weak start).
    const track = measure(countIn({ ticks: range(0, 8), fill: 8, groove: 9, bpm }), bpm);
    expect(track.firstBeat).toBeCloseTo(FIRST, 1);
    expect(verdict(track, bpm)).toEqual({ chosen: null, rejected: [{ index: 0, reason: 'weak-start' }] });
  });

  describe('on a pulse the tracker follows at double time', () => {
    // 8th notes at 90 bpm: the tracker beats at 180, and the measure folds that back to the 90 of the music. Ticks on
    // every 8th note up to beat `groove`, then the groove on every 8th; with `pickup` the groove's first hit is the
    // off-beat 8th before its downbeat, and with `fill` there is a fill (a hit of its own, 9 dB under the groove) on that beat.
    const eighths = ({ groove, pickup = false, fill }: { groove: number; pickup?: boolean; fill?: number }): Float32Array => {
      const at = (eighth: number) => beatAt(eighth / 2, 90);
      const firstGroove = groove * 2 - (pickup ? 1 : 0);
      const mono = addClicks(silence(), range(0, firstGroove).map(at), { gainDb: -22, clickSeconds: 0.03 });
      addClicks(mono, range(firstGroove, 80).map(at), { gainDb: -3, clickSeconds: 0.2 });
      if (fill !== undefined) for (let n = 0; n < 4; n++) addClicks(mono, [beatAt(fill, 90) + (n * 15) / 90], { gainDb: -12, clickSeconds: 0.1 });
      return mono;
    };

    it('counts the lead-in in beats of the music, not of the tracker: the groove on beat 6 is in', () => {
      const mono = eighths({ groove: 6 });
      expect(new MusicTempo(mono, { hopSize: 441, timeStep: 0.01 }).beatInterval).toBeCloseTo(60 / 180, 2); // double time
      const track = measure(mono, 96);
      expect(track.measuredBpm).toBeCloseTo(90, 0);
      expect(track.firstBeat).toBeCloseTo(beatAt(6, 90), 1); // 4.0 s after the first sound, past the 2.8 s that 8.5 tracker beats (at 180 bpm) would give
      expect(verdict(track, 96)).toEqual({ chosen: 0, rejected: [] });
    });

    it('steps by beats of the music: it opens on the downbeat, not on the off-beat 8th that leads into it', () => {
      const track = measure(eighths({ groove: 6, pickup: true }), 96);
      expect(track.firstBeat).toBeCloseTo(beatAt(6, 90), 1);
      expect(verdict(track, 96)).toEqual({ chosen: 0, rejected: [] });
    });

    it('tells the strong beats from 4 beats of the music past the lead-in: a fill is not taken for a groove on beat 12', () => {
      const track = measure(eighths({ groove: 12, fill: 6 }), 96);
      expect(track.firstBeat).toBeCloseTo(FIRST, 1);
      expect(verdict(track, 96)).toEqual({ chosen: null, rejected: [{ index: 0, reason: 'weak-start' }] });
    });

    it('measures a skip in beats of the music: 40 ms cut out of a groove it follows at double time is a jump', () => {
      // The groove on every 8th from the first, and 40 ms cut out at 11.1 s, in the silence between two of its hits.
      const mono = spliced(eighths({ groove: 0 }), 11.1, -40);
      expect(new MusicTempo(mono, { hopSize: 441, timeStep: 0.01 }).beatInterval).toBeCloseTo(60 / 180, 2); // double time
      const track = measure(mono, 96);
      expect(track.measuredBpm).toBeCloseTo(90, 0);
      expect(verdict(track, 96).rejected).toEqual([{ index: 0, reason: 'jump' }]);
      expect(track.maxJumpMs).toBeGreaterThanOrEqual(36);
      expect(track.maxJumpMs).toBeLessThanOrEqual(44);
    });
  });

  it('does not search from a start that chooseTrack would accept: -30.03 dB reads as -30.0', () => {
    // Four hits at gain -15.41 dB, which read -30.03 dB over 250 ms from the grid (-30.0 to the tenth, as chooseTrack sees
    // it), and the louder groove from beat 4: the video opens on the first hit.
    const mono = addClicks(silence(), range(0, 4).map((beat) => beatAt(beat)), { gainDb: -15.41 });
    addClicks(mono, range(4, 40).map((beat) => beatAt(beat)), { gainDb: -3 });
    const track = measure(mono);
    expect(track.startRmsDb).toBe(-30);
    expect(track.firstBeat).toBeCloseTo(FIRST, 1);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
  });

  it('does not take for the groove a beat inside a tone that no hit starts on', () => {
    // A tone that starts 0.2 s before beat 3 and rings past it: loud on that beat, but nothing starts within 40 ms of it.
    const mono = addClicks(silence(), range(6, 40).map((beat) => beatAt(beat)), { gainDb: -3 });
    addClicks(mono, [...range(0, 3), 5].map((beat) => beatAt(beat)), { gainDb: -26, clickSeconds: 0.03 });
    addClicks(mono, [beatAt(3) - 0.2], { gainDb: -3, clickSeconds: 1 });
    const track = measure(mono);
    expect(track.firstBeat).toBeCloseTo(beatAt(6), 1);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
  });

  it('does not move a start that is already a hit, however much louder the groove after it is', () => {
    // Four beats of hits at -25 dB, then the groove at -16 dB: the video opens on the first hit, as it always did.
    const mono = addClicks(silence(), range(0, 4).map((beat) => beatAt(beat)), { gainDb: -12 });
    addClicks(mono, range(4, 40).map((beat) => beatAt(beat)), { gainDb: -3 });
    const track = measure(mono);
    expect(track.firstBeat).toBeCloseTo(FIRST, 1);
    expect(track.startRmsDb).toBeGreaterThan(-30);
    expect(track.startRmsDb).toBeLessThan(-20);
    expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
  });

  // Run 4 (cobrame.app) was delivered with a track that skips once: the kick sat on its grid up to 10.8 s and 27 to 51 ms
  // early from 11.3 s to the end. The step spreads over the whole fit, so the residual (about 20 ms) was under its limit.
  describe('on a pulse that jumps once and stays there', () => {
    // The groove from 0.3 s: a hit of 0.25 s on every beat of 0.55 s, and silence for the rest of the beat.
    const groove = () => addClicks(silence(), beats(0.3));

    it('rejects a groove that skips 40 ms early at 11 s', () => {
      const track = measure(spliced(groove(), 11, -40));
      // The residual alone lets it through (that is how it was delivered); the jump is what stops it.
      expect(track.beatResidualMs).toBeLessThan(30);
      expect(verdict(track).rejected).toEqual([{ index: 0, reason: 'jump' }]);
    });

    it('rejects the same skip late as well as early', () => {
      expect(verdict(measure(spliced(groove(), 11, 40))).rejected).toEqual([{ index: 0, reason: 'jump' }]);
    });

    it.each([-80, -60, -40, -20, 20, 40, 60, 80])('reads a skip of %d ms (early when negative) as its size, to within 4 ms', (ms) => {
      const track = measure(spliced(groove(), 11, ms));
      expect(track.maxJumpMs).toBeGreaterThanOrEqual(Math.abs(ms) - 4);
      expect(track.maxJumpMs).toBeLessThanOrEqual(Math.abs(ms) + 4);
    });

    it.each([-25, -15, 15, 25])('passes a skip of %d ms (early when negative)', (ms) => {
      expect(verdict(measure(spliced(groove(), 11, ms)))).toEqual({ chosen: 0, rejected: [] });
    });

    it('measures a steady groove at a few ms', () => {
      expect(measure(addClicks(silence(), beats(0.3))).maxJumpMs).toBeLessThan(10);
    });

    it('rejects a skip in the last two beats the video plays', () => {
      // The video plays up to 19.6 s; after the skip at 18.6 s it plays two beats, at about 18.8 s and 19.4 s.
      const track = measure(spliced(groove(), 18.6, -40));
      expect(verdict(track).rejected).toEqual([{ index: 0, reason: 'jump' }]);
      expect(track.maxJumpMs).toBeGreaterThanOrEqual(36);
    });

    it('passes a step that falls after the part the video plays', () => {
      // The video plays 19.3 s from 0.3 s, up to 19.6 s: the skip at 21.3 s is never heard.
      const mono = spliced(groove(), 21.3, -40);
      const track = measure(mono);
      expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
      expect(track.maxJumpMs).toBeLessThan(10);
      // A longer video plays it.
      expect(chooseTrack([measureTrack(mono, SAMPLE_RATE, 112, 24)], 112, 24).rejected).toEqual([{ index: 0, reason: 'jump' }]);
    });

    it('looks at every beat from the start when the length of the video is not given, past the first 25 s too', () => {
      // The tempo is found from the first 25 s; the skip is at 26.3 s.
      const mono = spliced(groove(), 26.3, -40);
      expect(chooseTrack([measureTrack(mono, SAMPLE_RATE, 112)], 112, 19.3).rejected).toEqual([{ index: 0, reason: 'jump' }]);
      // A 28 s video plays it too.
      expect(chooseTrack([measureTrack(mono, SAMPLE_RATE, 112, 28)], 112, 28).rejected).toEqual([{ index: 0, reason: 'jump' }]);
    });

    it('reads no skip in the silence after the music stops inside the video', () => {
      // The groove stops at 15 s, inside the video (0.3 s to 19.6 s): past its last sound there is nothing to line up.
      expect(measure(addClicks(silence(), beats(0.3).filter((time) => time < 15))).maxJumpMs).toBeLessThan(10);
    });

    it('passes a step that falls before the start of the video', () => {
      // A count-in whose soft ticks move 40 ms early from the 5th, and the groove on beat 8, on the grid: the video starts on
      // the groove (beat 8), so the step is behind it.
      const mono = addClicks(silence(), range(8, 40).map((beat) => beatAt(beat)), { gainDb: -3 });
      addClicks(mono, range(0, 8).map((beat) => beatAt(beat) - (beat >= 4 ? 0.04 : 0)), { gainDb: -26, clickSeconds: 0.03 });
      const track = measure(mono);
      expect(track.firstBeat).toBeCloseTo(beatAt(8), 1);
      expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
      expect(track.maxJumpMs).toBeLessThan(10);
    });

    it('does not count the beats the fit left out as a jump (cand-3)', () => {
      // The three beats after the first hit sit a 16th early (136 ms): left out of the fit, and further off the beat than a
      // skip is looked for (a 6th of a beat), so the hits that line up are those on the beat.
      const track = measure(addClicks(silence(), introFigure(0.5)));
      expect(track.droppedBeats).toBe(3);
      expect(track.maxJumpMs).toBeLessThan(10);
      expect(verdict(track)).toEqual({ chosen: 0, rejected: [] });
    });

    it('reports a pulse that moves by a 16th between sections as unsteady, the first check it fails (cand-1)', () => {
      const track = measure(addClicks(silence(), beats(0.3, (beat, time) => (beat < 12 ? -SIXTEENTH : time < 21.9 ? 0 : SIXTEENTH))));
      expect(track.maxJumpMs).toBeGreaterThan(33); // it jumps too
      expect(verdict(track).rejected).toEqual([{ index: 0, reason: 'unsteady' }]);
    });
  });
});

describe('chooseTrack', () => {
  const ok = (energyDb: number): TrackMeasure => ({ seconds: 60, measuredBpm: 113, firstBeat: 0.1, beatResidualMs: 8, startRmsDb: -18, energyDb });
  const reasons = (cands: TrackMeasure[], requestedBpm = 112, videoSeconds = 20) =>
    chooseTrack(cands, requestedBpm, videoSeconds).rejected.map((x) => x.reason);

  it('rejects off-tempo, unsteady, late and weak starts, and picks the most energetic of the rest', () => {
    const r = chooseTrack(
      [
        { ...ok(-20), measuredBpm: 140 },
        { ...ok(-20), beatResidualMs: 45 },
        { ...ok(-20), firstBeat: 4.7 }, // 8.5 beats at 113 bpm are 4.51 s
        { ...ok(-20), startRmsDb: -40 },
        ok(-20),
        ok(-16),
      ],
      112,
      20,
    );
    expect(r.chosen).toBe(5);
    expect(r.rejected.map((x) => x.reason)).toEqual(['bpm', 'unsteady', 'late-start', 'weak-start']);
    expect(r.rejected.map((x) => x.index)).toEqual([0, 1, 2, 3]);
  });

  it('rejects a track that ends before the video does', () => {
    // 20 s of video, but only 19.9 s of track after the first beat.
    expect(reasons([{ ...ok(-16), seconds: 20, firstBeat: 0.1 }])).toEqual(['too-short']);
  });

  it('accepts a track that is exactly as long as the video from its first beat', () => {
    expect(chooseTrack([{ ...ok(-16), seconds: 21, firstBeat: 1 }], 112, 20).chosen).toBe(0);
  });

  it('measures the tempo against the request, in both directions', () => {
    expect(reasons([{ ...ok(-16), measuredBpm: 129 }])).toEqual(['bpm']); // 15.2 % above 112
    expect(reasons([{ ...ok(-16), measuredBpm: 95 }])).toEqual(['bpm']); // 15.2 % below 112
    expect(reasons([{ ...ok(-16), measuredBpm: 128 }, { ...ok(-16), measuredBpm: 96 }])).toEqual([]);
    // 15 % is of the requested tempo, not of the measured one (16 % of 100, but only 13.8 % of 116).
    expect(reasons([{ ...ok(-16), measuredBpm: 116 }], 100)).toEqual(['bpm']);
    expect(reasons([{ ...ok(-16), measuredBpm: 114 }], 100)).toEqual([]);
  });

  it('accepts a short intro: the render cuts the track from its first beat', () => {
    // 1.4 s and 1.115 s (the cobrame track the user chose by ear) are fine, and so is 2.1 s: 8.5 beats at 113 bpm are 4.51 s.
    expect(reasons([{ ...ok(-16), firstBeat: 1.4 }, { ...ok(-16), firstBeat: 1.115 }, { ...ok(-16), firstBeat: 2.1 }])).toEqual([]);
  });

  it.each([
    { bpm: 96, justUnder: 5.25, justOver: 5.4 }, // 8.5 beats are 5.31 s
    { bpm: 120, justUnder: 4.2, justOver: 4.3 }, // 8.5 beats are 4.25 s
  ])('calls a start late when it is more than 8.5 beats after the first sound: $bpm bpm', ({ bpm, justUnder, justOver }) => {
    expect(reasons([{ ...ok(-16), measuredBpm: bpm, firstBeat: justUnder }], bpm)).toEqual([]);
    expect(reasons([{ ...ok(-16), measuredBpm: bpm, firstBeat: justOver }], bpm)).toEqual(['late-start']);
  });

  it('counts a late start from where the sound starts, when the measure says (silence before it is never heard)', () => {
    // 8.5 beats at 120 bpm are 4.25 s: 4.2 s after the sound is fine and 4.4 s is not, whatever the silence before it.
    expect(reasons([{ ...ok(-16), measuredBpm: 120, firstBeat: 6.4, audioStart: 2.2 }])).toEqual([]);
    expect(reasons([{ ...ok(-16), measuredBpm: 120, firstBeat: 6.6, audioStart: 2.2 }])).toEqual(['late-start']);
  });

  it('keeps tracks that sit exactly on a limit', () => {
    // 8.5 beats at 120 bpm are exactly 4.25 s.
    const onTheLimit = { ...ok(-16), measuredBpm: 120, beatResidualMs: 30, firstBeat: 4.25, startRmsDb: -30, seconds: 24.25 };
    expect(chooseTrack([onTheLimit], 112, 20)).toEqual({ chosen: 0, rejected: [] });
  });

  it('reports the first check a track fails', () => {
    expect(reasons([{ ...ok(-16), measuredBpm: 160, beatResidualMs: 90, firstBeat: 5, startRmsDb: -50, seconds: 5 }])).toEqual(['bpm']);
    expect(reasons([{ ...ok(-16), beatResidualMs: 90, firstBeat: 5, startRmsDb: -50, seconds: 5 }])).toEqual(['unsteady']);
    expect(reasons([{ ...ok(-16), firstBeat: 5, startRmsDb: -50, seconds: 5 }])).toEqual(['late-start']);
    expect(reasons([{ ...ok(-16), startRmsDb: -50, seconds: 5 }])).toEqual(['weak-start']);
  });

  it('rejects a track whose pulse jumps by more than 33 ms, and keeps one that jumps by exactly 33', () => {
    expect(reasons([{ ...ok(-16), maxJumpMs: 34 }])).toEqual(['jump']);
    expect(chooseTrack([{ ...ok(-16), maxJumpMs: 33 }], 112, 20)).toEqual({ chosen: 0, rejected: [] });
  });

  it('takes a measure from before the jump was measured as one that does not jump', () => {
    expect(ok(-16).maxJumpMs).toBeUndefined();
    expect(chooseTrack([ok(-16)], 112, 20)).toEqual({ chosen: 0, rejected: [] });
  });

  it('checks the jump after the tempo and the steadiness, and before the start and the length', () => {
    const jumps = { ...ok(-16), maxJumpMs: 60 };
    expect(reasons([{ ...jumps, measuredBpm: 160, beatResidualMs: 90 }])).toEqual(['bpm']);
    expect(reasons([{ ...jumps, beatResidualMs: 90, firstBeat: 5, startRmsDb: -50, seconds: 5 }])).toEqual(['unsteady']);
    expect(reasons([{ ...jumps, firstBeat: 5, startRmsDb: -50, seconds: 5 }])).toEqual(['jump']);
  });

  it('chooses another track when the most energetic one jumps', () => {
    const r = chooseTrack([{ ...ok(-10), maxJumpMs: 40 }, ok(-16)], 112, 20);
    expect(r).toEqual({ chosen: 1, rejected: [{ index: 0, reason: 'jump' }] });
  });

  it('prefers the tempo closest to the request when the energy ties', () => {
    const r = chooseTrack([{ ...ok(-16), measuredBpm: 118 }, { ...ok(-16), measuredBpm: 111 }, { ...ok(-16), measuredBpm: 125 }], 112, 20);
    expect(r.chosen).toBe(1);
  });

  it('prefers the first of two tracks that tie on everything', () => {
    expect(chooseTrack([ok(-16), ok(-16)], 112, 20).chosen).toBe(0);
  });

  it('chooses nothing when no track passes, and says why for each', () => {
    const r = chooseTrack([{ ...ok(-16), measuredBpm: 140 }, { ...ok(-16), seconds: 10 }], 112, 20);
    expect(r).toEqual({
      chosen: null,
      rejected: [
        { index: 0, reason: 'bpm' },
        { index: 1, reason: 'too-short' },
      ],
    });
  });

  it('chooses nothing from an empty list', () => expect(chooseTrack([], 112, 20)).toEqual({ chosen: null, rejected: [] }));
});

describe('musicPrompt', () => {
  it('writes the tempo, the length and "Instrumental only, no vocals." into the prompt', () => {
    const p = musicPrompt(edlShop, 19.3);
    expect(p).toContain('112 BPM');
    expect(p).toContain('Length: 20 seconds');
    expect(p).toContain('Instrumental only, no vocals.');
  });

  it('starts with the direction of the edit list', () => expect(musicPrompt(edlShop, 19.3).split('\n')[0]).toBe(edlShop.musicPrompt));

  it('lays the structure over the timeline of the main hook', () => {
    const { scenes } = layoutScenes(edlShop, 0);
    const body = scenes.find((s) => s.role === 'body');
    const cta = scenes.find((s) => s.role === 'cta');
    // 6 beats of hook and then 24 of body at 112 bpm: the body starts at 3.2 s and the end card at 16.1 s.
    expect(Math.round((body?.from ?? 0) / 30)).toBe(3);
    expect(Math.round((cta?.from ?? 0) / 30)).toBe(16);
    const lines = musicPrompt(edlShop, 19.3).split('\n');
    expect(lines).toContain('Structure:');
    expect(lines.filter((l) => l.startsWith('['))).toEqual([
      '[0:00 - 0:03] Intro: a confident hit on the first downbeat and the groove starts right away.',
      '[0:03 - 0:16] Main groove, building gently.',
      '[0:16 - 0:20] Clean ending that resolves on a final hit at 0:20, then silence.',
    ]);
  });

  it('writes a length of a minute or more as minutes and seconds', () => {
    const p = musicPrompt(edlShop, 59.5);
    expect(p).toContain('Length: 60 seconds');
    expect(p).toContain('a final hit at 1:00,');
    expect(p).not.toContain('0:60');
  });
});

describe('trackCoversVideo', () => {
  it('takes a track that lasts the video from its first beat', () => {
    expect(trackCoversVideo({ seconds: 21.8, firstBeat: 0.2 }, 21.6)).toBe(true);
  });

  it('puts up with a track that falls half a second short or less, as the render does', () => {
    expect(trackCoversVideo({ seconds: 21.1, firstBeat: 0.2 }, 21.4)).toBe(true);
    expect(MAX_TRACK_SHORT_FALL_SECONDS).toBe(0.5);
  });

  it('refuses a track that falls more than half a second short', () => {
    expect(trackCoversVideo({ seconds: 21.8, firstBeat: 0.2 }, 22.2)).toBe(false);
  });

  it('counts a first beat before the start of the file as the start', () => {
    expect(trackCoversVideo({ seconds: 20, firstBeat: -0.3 }, 20.4)).toBe(true);
  });
});
