// The real MusicPort over the Gemini API. Most of it runs against a stand-in for the SDK client; the part that is about the
// SDK's own behavior (it must not retry a paid call, and must give up on a call that hangs) runs the real SDK against a
// server on this machine. Lyria itself is never called in a test.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleGenAI } from '@google/genai';
import { FatalError } from 'workflow';
import { afterEach, describe, expect, it } from 'vitest';
import type { MusicModel } from '@app/core';
import { clickWav } from '@app/core/testing';
import { LyriaMusic, type LyriaClient } from '../src/adapters/real/music';
import { MusicOutputInvalid } from '../src/ports';

type Created = Parameters<LyriaClient['interactions']['create']>;
type Reply = Awaited<ReturnType<LyriaClient['interactions']['create']>>;

// A client that answers with `reply` and keeps what it was asked.
const client = (reply: Reply) => {
  const asked: Created[] = [];
  const stub: LyriaClient = {
    interactions: {
      create: async (...args) => {
        asked.push(args);
        return reply;
      },
    },
  };
  return { stub, asked };
};

const wav = clickWav({ bpm: 112, seconds: 2, offset: 0.2, gainDb: -6 });
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const audio = (bytes: Uint8Array, mime_type = 'audio/wav') => ({ output_audio: { data: base64(bytes), mime_type } });
const refusal = async (music: LyriaMusic, model: MusicModel = 'lyria-3.5'): Promise<unknown> => music.generate('x', model).catch((error: unknown) => error);

describe('LyriaMusic.generate', () => {
  it('asks the model it is given for a WAV with the prompt: Lyria 3.5', async () => {
    const { stub, asked } = client(audio(wav));
    await new LyriaMusic(stub).generate('Upbeat Latin pop', 'lyria-3.5');
    expect(asked.map(([params]) => params)).toEqual([
      { model: 'lyria-3.5', input: 'Upbeat Latin pop', response_format: { type: 'audio', mime_type: 'audio/wav' } },
    ]);
  });

  it('asks the model it is given for a WAV with the prompt: Lyria 3 Pro', async () => {
    const { stub, asked } = client(audio(wav));
    await new LyriaMusic(stub).generate('Upbeat Latin pop', 'lyria-3-pro-preview');
    expect(asked.map(([params]) => params)).toEqual([
      { model: 'lyria-3-pro-preview', input: 'Upbeat Latin pop', response_format: { type: 'audio', mime_type: 'audio/wav' } },
    ]);
  });

  it.each(['lyria-3.5', 'lyria-3-pro-preview'] as const)('gives back the bytes of the WAV, the model that made it (%s) and what the track costs', async (model) => {
    const { stub } = client(audio(wav));
    const answer = await new LyriaMusic(stub).generate('x', model);
    expect({ ...answer, wav: Buffer.from(answer.wav).equals(wav) }).toEqual({ wav: true, model, usd: 0.08 });
  });

  it.each(['lyria-3.5', 'lyria-3-pro-preview'] as const)('says what a refused answer cost for %s', async (model) => {
    const { stub } = client({});
    expect(await refusal(new LyriaMusic(stub), model)).toMatchObject({ usd: 0.08 });
  });

  it('refuses an answer that is not a WAV, without converting it, and says what it cost', async () => {
    // MP3 is what Lyria sends when it is not asked for a WAV.
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const { stub } = client(audio(mp3, 'audio/mpeg'));
    const failure = await refusal(new LyriaMusic(stub));
    expect(failure).toBeInstanceOf(MusicOutputInvalid);
    expect(failure).toMatchObject({ usd: 0.08 });
    expect((failure as Error).message).toContain('audio/mpeg');
  });

  it('refuses an answer with no audio, and says what it cost', async () => {
    const { stub } = client({});
    const failure = await refusal(new LyriaMusic(stub));
    expect(failure).toBeInstanceOf(MusicOutputInvalid);
    expect(failure).toMatchObject({ usd: 0.08 });
  });

  it('refuses an audio block with no data', async () => {
    const { stub } = client({ output_audio: { mime_type: 'audio/wav' } });
    expect(await refusal(new LyriaMusic(stub))).toBeInstanceOf(MusicOutputInvalid);
  });

  it('never has a refused answer retried: it is a FatalError, since a retry would be billed again', async () => {
    const { stub } = client({});
    const failure = await refusal(new LyriaMusic(stub));
    expect(FatalError.is(failure)).toBe(true);
    expect(failure).toBeInstanceOf(FatalError);
  });

  it('lets the SDK own errors through, so the step can retry what is worth retrying', async () => {
    const stub: LyriaClient = {
      interactions: {
        create: async () => {
          throw new Error('503 Service Unavailable');
        },
      },
    };
    const failure = await refusal(new LyriaMusic(stub));
    expect(FatalError.is(failure)).toBe(false);
    expect((failure as Error).message).toBe('503 Service Unavailable');
  });

  it('asks for no retries by the SDK and for a time limit on the call', async () => {
    const { stub, asked } = client(audio(wav));
    await new LyriaMusic(stub).generate('x', 'lyria-3.5');
    await new LyriaMusic(stub, 12_000).generate('x', 'lyria-3-pro-preview');
    expect(asked.map(([, options]) => options)).toEqual([
      { timeout_ms: 90_000, retries: { strategy: 'none' } },
      { timeout_ms: 12_000, retries: { strategy: 'none' } },
    ]);
  });
});

describe('LyriaMusic over the real SDK', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((done) => (server ? server.close(done) : done(undefined)));
    server = undefined;
  });

  // The SDK pointed at a server on this machine, which answers every request with `handler`.
  const sdkAgainst = async (handler: Parameters<typeof createServer>[1]): Promise<{ client: GoogleGenAI; requests: () => number }> => {
    let count = 0;
    server = createServer((request, response) => {
      count += 1;
      handler?.(request, response);
    });
    await new Promise<void>((ready) => server?.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    return { client: new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: `http://127.0.0.1:${port}` } }), requests: () => count };
  };

  it('does not send a call again that the server answered with an error, as the SDK does by default', async () => {
    const { client: sdk, requests } = await sdkAgainst((_request, response) => {
      response.statusCode = 503;
      response.setHeader('content-type', 'application/json');
      response.end('{"error":{"message":"overloaded"}}');
    });
    const failure = await refusal(new LyriaMusic(sdk));
    expect(failure).toMatchObject({ status: 503 });
    expect(FatalError.is(failure)).toBe(false);
    expect(requests()).toBe(1);
  });

  it('gives up on a call that does not come back in the time it was given', async () => {
    const { client: sdk, requests } = await sdkAgainst(() => undefined);
    const failure = await refusal(new LyriaMusic(sdk, 300));
    expect((failure as Error).message).toContain('timed out');
    expect(requests()).toBe(1);
  });
});
