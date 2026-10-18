// The MusicPort as a double, for the tests that make the music without Lyria. It hands out the tracks a test queues, one
// per call, and when there are none queued it makes a click track that suits the prompt it is given (the tempo and the
// length that musicPrompt writes in it), so a flow that tells it nothing still ends with a track that passes the checks.
// It counts its calls and keeps the prompts, so a test can say Lyria was (or was not) asked, and with what.
import { clickWav } from '@app/core/testing';
import type { MusicPort } from '../../ports';

const TEMPO = /Tempo: exactly (\d+(?:\.\d+)?) BPM/;
const LENGTH = /Length: (\d+) seconds/;

// A little longer than the video the prompt asks for: a track that ends with the video is too short once its first beat
// is counted. The hits are long (0.25 s) and loud enough for the start of the track to read as music.
const EXTRA_SECONDS = 2;
const FIRST_BEAT_SECONDS = 0.2;
const CLICK_SECONDS = 0.25;
const GAIN_DB = -6;

const suitedTrack = (prompt: string): Uint8Array => {
  const bpm = TEMPO.exec(prompt)?.[1];
  const seconds = LENGTH.exec(prompt)?.[1];
  if (bpm === undefined || seconds === undefined) {
    throw new Error('The FakeMusic reads the tempo and the length from the prompt that musicPrompt writes, and this one has neither: a test queues its own tracks.');
  }
  return clickWav({ bpm: Number(bpm), seconds: Number(seconds) + EXTRA_SECONDS, offset: FIRST_BEAT_SECONDS, gainDb: GAIN_DB, clickSeconds: CLICK_SECONDS });
};

export class FakeMusic implements MusicPort {
  /** How many times Lyria was asked, whatever came of it. */
  calls = 0;
  /** What each call was asked, in order. */
  readonly prompts: string[] = [];
  /** The WAV files the next calls give back, one each, in order. */
  queue: Uint8Array[] = [];
  /** The call (counting from 1) that fails, as a provider's error does. */
  failAt: number | undefined;
  /** What each call costs. */
  usd = 0.08;

  async generate(prompt: string): ReturnType<MusicPort['generate']> {
    this.calls += 1;
    this.prompts.push(prompt);
    if (this.calls === this.failAt) throw new Error('Lyria is down');
    return { wav: this.queue.shift() ?? suitedTrack(prompt), model: 'lyria-3.5', usd: this.usd };
  }
}
