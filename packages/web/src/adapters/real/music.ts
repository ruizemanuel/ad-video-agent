// The MusicPort over the Gemini API: Lyria 3.5 or Lyria 3 Pro (the model it is asked for), asked for a WAV. The call is the
// Interactions API (`interactions.create`) and the track comes back in `output_audio`, base64. Lyria takes no tempo or
// length, so those go in the prompt and the track is measured afterwards (pipeline/music.ts).
import type { MusicModel } from '@app/core';
import { MusicOutputInvalid, type MusicPort } from '../../ports';

/**
 * US$ per track and model: the whole track is billed, whether or not it is used. Gemini API pricing, checked on
 * 20/10/2026 at https://ai.google.dev/gemini-api/docs/pricing: `lyria-3.5` "Full Song" and `lyria-3-pro-preview` "Full Song"
 * (listed there under the legacy Lyria 3 family) are both US$ 0.08 per song.
 */
const PRICE_PER_TRACK_USD: Record<MusicModel, number> = {
  'lyria-3.5': 0.08,
  'lyria-3-pro-preview': 0.08,
};

/** Lyria answers in 18 to 26 s (quality test, 17/10/2026); a call that takes this long is given up on. */
const DEFAULT_TIMEOUT_MS = 90_000;

/** What the adapter asks of each call. The SDK retries a request up to four times on a 408, 409, 429 or 5xx, and has no time limit. */
type CallOptions = {
  timeout_ms: number;
  /** No retries by the SDK: a call that is sent again may be billed again. Whoever calls decides about retrying. */
  retries: { strategy: 'none' };
};

/** What the adapter needs of the SDK's client (`new GoogleGenAI({ apiKey })`): the tests give a stand-in. */
export type LyriaClient = {
  interactions: {
    create(
      params: {
        model: MusicModel;
        input: string;
        response_format: { type: 'audio'; mime_type: 'audio/wav' };
      },
      options: CallOptions,
    ): Promise<{ output_audio?: { data?: string; mime_type?: string } }>;
  };
};

// A WAV file starts with "RIFF".
const isRiff = (bytes: Uint8Array): boolean => bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF';

export class LyriaMusic implements MusicPort {
  constructor(
    private readonly client: LyriaClient,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async generate(prompt: string, model: MusicModel): ReturnType<MusicPort['generate']> {
    const interaction = await this.client.interactions.create(
      { model, input: prompt, response_format: { type: 'audio', mime_type: 'audio/wav' } },
      { timeout_ms: this.timeoutMs, retries: { strategy: 'none' } },
    );
    const audio = interaction.output_audio;
    // From here on the call has been billed, so a refusal says what it cost.
    const usd = PRICE_PER_TRACK_USD[model];
    if (!audio?.data) throw new MusicOutputInvalid('Lyria answered with no audio.', usd);
    const wav = new Uint8Array(Buffer.from(audio.data, 'base64'));
    // The file is the one Lyria sent: nothing here converts an MP3 into a WAV.
    if (!isRiff(wav)) {
      throw new MusicOutputInvalid(`Lyria did not answer with a WAV file (${audio.mime_type ?? 'no content type'}).`, usd);
    }
    return { wav, model, usd };
  }
}
