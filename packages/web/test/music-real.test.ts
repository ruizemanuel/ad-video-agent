// The real MusicPort over the Gemini API, run against a stand-in for the SDK client: no network and no money. It checks
// what is asked of Lyria and how the answer is read. The call itself is never made in a test.
import { FatalError } from 'workflow';
import { describe, expect, it } from 'vitest';
import { clickWav } from '@app/core/testing';
import { LyriaMusic, type LyriaClient } from '../src/adapters/real/music';

type Created = Parameters<LyriaClient['interactions']['create']>[0];

// A client that answers with `reply` and keeps what it was asked.
const client = (reply: Awaited<ReturnType<LyriaClient['interactions']['create']>>) => {
  const asked: Created[] = [];
  const stub: LyriaClient = {
    interactions: {
      create: async (params) => {
        asked.push(params);
        return reply;
      },
    },
  };
  return { stub, asked };
};

const wav = clickWav({ bpm: 112, seconds: 2, offset: 0.2, gainDb: -6 });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const audio = (bytes: Uint8Array, mime_type = 'audio/wav') => ({ output_audio: { data: base64(bytes), mime_type } });

describe('LyriaMusic.generate', () => {
  it('asks Lyria 3.5 for a WAV with the prompt', async () => {
    const { stub, asked } = client(audio(wav));
    await new LyriaMusic(stub).generate('Upbeat Latin pop');
    expect(asked).toEqual([{ model: 'lyria-3.5', input: 'Upbeat Latin pop', response_format: { type: 'audio', mime_type: 'audio/wav' } }]);
  });

  it('gives back the bytes of the WAV, the model and what the track costs', async () => {
    const { stub } = client(audio(wav));
    const answer = await new LyriaMusic(stub).generate('x');
    expect({ ...answer, wav: Buffer.from(answer.wav).equals(wav) }).toEqual({ wav: true, model: 'lyria-3.5', usd: 0.08 });
  });

  it('refuses an answer that is not a WAV, without converting it, and never retries it', async () => {
    // MP3 is what Lyria sends when it is not asked for a WAV.
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const { stub } = client(audio(mp3, 'audio/mpeg'));
    const failure = await new LyriaMusic(stub).generate('x').catch((error: unknown) => error);
    expect(FatalError.is(failure)).toBe(true);
    expect((failure as Error).message).toContain('audio/mpeg');
  });

  it('refuses an answer with no audio, and never retries it', async () => {
    const { stub } = client({});
    const failure = await new LyriaMusic(stub).generate('x').catch((error: unknown) => error);
    expect(FatalError.is(failure)).toBe(true);
  });

  it('refuses an audio block with no data', async () => {
    const { stub } = client({ output_audio: { mime_type: 'audio/wav' } });
    const failure = await new LyriaMusic(stub).generate('x').catch((error: unknown) => error);
    expect(FatalError.is(failure)).toBe(true);
  });

  it('lets the SDK own errors through, so the step can retry what is worth retrying', async () => {
    const stub: LyriaClient = {
      interactions: {
        create: async () => {
          throw new Error('503 Service Unavailable');
        },
      },
    };
    const failure = await new LyriaMusic(stub).generate('x').catch((error: unknown) => error);
    expect(FatalError.is(failure)).toBe(false);
    expect((failure as Error).message).toBe('503 Service Unavailable');
  });
});
