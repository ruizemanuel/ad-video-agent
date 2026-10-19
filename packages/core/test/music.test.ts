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
  const measure = (mono: Float32Array) => measureTrack(mono, SAMPLE_RATE, 112, VIDEO_SECONDS);
  const verdict = (track: TrackMeasure) => chooseTrack([track], 112, VIDEO_SECONDS);

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

  it('does not move the start back onto a hit too soft to open the video', () => {
    // The intro figure, but the hit on the grid before it is a 10 ms tick.
    const mono = addClicks(silence(), introFigure(0.5).slice(1));
    addClicks(mono, [0.5], { clickSeconds: 0.01 });
    const track = measure(mono);
    expect(track.firstBeat).toBeCloseTo(0.5 + BEAT, 1);
    expect(verdict(track).rejected).toEqual([{ index: 0, reason: 'weak-start' }]);
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

  it('still finds weak the start of a track that opens on a soft count-in (cand-2)', () => {
    // Ticks on beats 0-2, a 16th-note fill rising into beat 4, and the groove from there.
    const mono = addClicks(silence(), beats(0.5).slice(4));
    addClicks(mono, beats(0.5).slice(0, 3), { gainDb: -26, clickSeconds: 0.01 });
    [-24, -20, -16, -12].forEach((gainDb, n) => addClicks(mono, [0.5 + 3 * BEAT + n * SIXTEENTH], { gainDb, clickSeconds: 0.05 }));
    const track = measure(mono);
    expect(track.firstBeat).toBeCloseTo(0.5, 1);
    expect(verdict(track).rejected).toEqual([{ index: 0, reason: 'weak-start' }]);
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
        { ...ok(-20), firstBeat: 2.4 },
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
    // 1.4 s and 1.115 s (the cobrame track the user chose by ear) are fine; 2.1 s is not.
    expect(reasons([{ ...ok(-16), firstBeat: 1.4 }, { ...ok(-16), firstBeat: 1.115 }])).toEqual([]);
    expect(reasons([{ ...ok(-16), firstBeat: 2.1 }])).toEqual(['late-start']);
  });

  it('counts a late start from where the sound starts, when the measure says (silence before it is never heard)', () => {
    expect(reasons([{ ...ok(-16), firstBeat: 4.1, audioStart: 2.2 }])).toEqual([]);
    expect(reasons([{ ...ok(-16), firstBeat: 4.3, audioStart: 2.2 }])).toEqual(['late-start']);
  });

  it('keeps tracks that sit exactly on a limit', () => {
    const onTheLimit = { ...ok(-16), beatResidualMs: 30, firstBeat: 2, startRmsDb: -30, seconds: 22 };
    expect(chooseTrack([onTheLimit], 112, 20)).toEqual({ chosen: 0, rejected: [] });
  });

  it('reports the first check a track fails', () => {
    expect(reasons([{ ...ok(-16), measuredBpm: 160, beatResidualMs: 90, firstBeat: 3, startRmsDb: -50, seconds: 5 }])).toEqual(['bpm']);
    expect(reasons([{ ...ok(-16), beatResidualMs: 90, firstBeat: 3, startRmsDb: -50, seconds: 5 }])).toEqual(['unsteady']);
    expect(reasons([{ ...ok(-16), firstBeat: 3, startRmsDb: -50, seconds: 5 }])).toEqual(['late-start']);
    expect(reasons([{ ...ok(-16), startRmsDb: -50, seconds: 5 }])).toEqual(['weak-start']);
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
