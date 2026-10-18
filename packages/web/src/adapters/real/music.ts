// The MusicPort over the Gemini API: Lyria 3.5, asked for a WAV. The call is the Interactions API (`interactions.create`)
// and the track comes back in `output_audio`, base64. Lyria takes no tempo or length, so those go in the prompt and the
// track is measured afterwards (pipeline/music.ts).
import { FatalError } from 'workflow';
import type { MusicPort } from '../../ports';

export const LYRIA_MODEL = 'lyria-3.5';

/** US$ per track (Gemini API pricing, 17/10/2026): the whole track is billed, whether or not it is used. */
const PRICE_PER_TRACK_USD = 0.08;

/** What the adapter needs of the SDK's client (`new GoogleGenAI({ apiKey })`): the tests give a stand-in. */
export type LyriaClient = {
  interactions: {
    create(params: {
      model: typeof LYRIA_MODEL;
      input: string;
      response_format: { type: 'audio'; mime_type: 'audio/wav' };
    }): Promise<{ output_audio?: { data?: string; mime_type?: string } }>;
  };
};

// A WAV file starts with "RIFF".
const isRiff = (bytes: Uint8Array): boolean => bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF';

export class LyriaMusic implements MusicPort {
  constructor(private readonly client: LyriaClient) {}

  async generate(prompt: string): ReturnType<MusicPort['generate']> {
    const interaction = await this.client.interactions.create({
      model: LYRIA_MODEL,
      input: prompt,
      response_format: { type: 'audio', mime_type: 'audio/wav' },
    });
    const audio = interaction.output_audio;
    // A track that did not come is not asked for again by a retry: the call was billed, and a second one would be too.
    if (!audio?.data) throw new FatalError('Lyria answered with no audio.');
    const wav = new Uint8Array(Buffer.from(audio.data, 'base64'));
    // The file is the one Lyria sent: nothing here converts an MP3 into a WAV.
    if (!isRiff(wav)) throw new FatalError(`Lyria did not answer with a WAV file (${audio.mime_type ?? 'no content type'}).`);
    return { wav, model: LYRIA_MODEL, usd: PRICE_PER_TRACK_USD };
  }
}
