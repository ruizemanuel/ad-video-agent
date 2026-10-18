// Edit decision list: what the director model outputs and the pieces render.
// The schema is structural; claims, numbers, banned phrases and the rest of the rules are checked in validate.ts.
import { z } from 'zod';

export const PIECES = ['KineticHeadline', 'UiFocus', 'UiScroll', 'ClaimStack', 'WordCycle', 'TypeIn', 'EndCard'] as const;

export const LineSchema = z.object({
  text: z.string().min(1).describe('On-screen text in the video language. Few words.'),
  kind: z
    .enum(['claim', 'framing'])
    .describe('claim: says something about the product (needs claimId). framing: question, pain or call to action, with no facts or numbers.'),
  claimId: z.string().optional().describe('Required when kind is "claim": id of the claim in `claims` that this line states.'),
  accent: z.string().optional().describe('Exact substring of `text` drawn in the brand color: one word or a short phrase.'),
  atBeat: z
    .number()
    .int()
    .optional()
    .describe('UiFocus and UiScroll only: beat of the scene at which this line replaces the previous one. Leave it out on the first line.'),
});

export const ClaimSchema = z.object({
  id: z.string().describe('Short id, e.g. "c1".'),
  text: z.string().describe('What the video claims, in plain words.'),
  sectionId: z.string().describe('Id of the site section whose text backs the claim.'),
  quote: z.string().describe('Verbatim excerpt of that section (heading or text), copied character by character.'),
});

export const SceneSchema = z.object({
  piece: z.enum(PIECES),
  beats: z.number().int().describe('Scene length in beats of the track.'),
  lines: z.array(LineSchema).describe('Text of the scene; see the piece rules.'),
  shotId: z.string().optional().describe('UiFocus and UiScroll: id of a screenshot from `shots`.'),
  boxIndex: z.number().int().optional().describe('UiFocus (required) and UiScroll (optional): index of the target box within that shot.'),
  variant: z
    .enum(['url', 'prompt'])
    .optional()
    .describe('TypeIn only: "url" types the site address, "prompt" types a framing question. Both end on a button that gets pressed.'),
  transitionIn: z.enum(['cut', 'wipe']).optional().describe('How the scene comes in. Default "cut".'),
});

export const EdlSchema = z.object({
  lang: z.string().describe('Language of the on-screen text, e.g. "es".'),
  bpm: z.number().int().describe('Tempo of the music; every cut lands on a beat.'),
  style: z.object({ energy: z.enum(['calm', 'bold']), density: z.enum(['airy', 'dense']) }),
  hooks: z
    .array(z.array(SceneSchema))
    .describe('Exactly three hooks, strongest first; hooks[0] is the main version. Each is 1-2 scenes, about 3 seconds.'),
  body: z.array(SceneSchema).describe('Body shared by the three hooks.'),
  cta: SceneSchema.describe('Closing scene: an EndCard.'),
  claims: z.array(ClaimSchema),
  musicPrompt: z.string().describe('Instrumental music direction in English: genre, mood, instruments. No artist names.'),
});

export type Line = z.infer<typeof LineSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type PieceName = (typeof PIECES)[number];
// `boxIndex` indexes the boxes of the site whose `shotId` is the scene's `shotId`.
export type Scene = z.infer<typeof SceneSchema>;
export type Edl = z.infer<typeof EdlSchema>;
