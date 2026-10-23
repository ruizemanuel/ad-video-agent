// POST /v1/videos/<id>/feedback: whether the client posted the video they got, free, for whoever has the order's id
// (the link to the order is the credential). Giving the answer again replaces it. It is shown in the order's status.
import { z } from 'zod';
import { getAdapters } from '../../../../../adapters';
import { FEEDBACK_ANSWERS, type Feedback } from '../../../../../ports';

const NO_STORE = { 'cache-control': 'no-store' };
const refuse = (status: number, error: string, reason: string): Response => Response.json({ error, reason }, { status, headers: NO_STORE });

const MAX_POST_URL = 2048;

const isHttps = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

// `postUrl` may be left out or null (no link); a blank one is a mistake, not "no link". Unknown keys are ignored.
const FeedbackBody = z.object({
  answer: z.enum(FEEDBACK_ANSWERS),
  postUrl: z
    .string()
    .max(MAX_POST_URL, `at most ${MAX_POST_URL} characters`)
    .regex(/^\S+$/, 'must be a link with no spaces in it')
    .refine(isHttps, 'must be an https link')
    .nullish(),
  mayShow: z.boolean().optional(),
});

type ParsedBody = { ok: true; feedback: Omit<Feedback, 'updatedAt'> } | { ok: false; reason: string };

async function readBody(req: Request): Promise<ParsedBody> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, reason: 'The body must be JSON.' };
  }
  const parsed = FeedbackBody.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') };
  const { answer, postUrl = null, mayShow = false } = parsed.data;
  return { ok: true, feedback: { answer, postUrl, mayShow } };
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = await readBody(req);
  if (!body.ok) return refuse(400, 'invalid_request', body.reason);
  const { store } = await getAdapters();
  const order = await store.getOrder(id);
  if (order === null) return refuse(404, 'order_not_found', 'There is no order with that id.');
  if (order.status !== 'delivered') return refuse(409, 'not_delivered', 'The answer can be given once the video is delivered.');
  // The store keeps mayShow false when there is no postUrl.
  await store.setFeedback(id, body.feedback);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
