// GET /v1/videos/<id>: the status of an order, free, for whoever has its id. It shows the steps as they happen and,
// once the order is delivered, a signed download link for each file, and the client's answer to "did you post it?"
// when there is one.
import { getAdapters } from '../../../../adapters';
import { env } from '../../../../env';
import { readStatus, serviceBase } from '../../../../payments/orders';

// The answer changes as the order moves, and once it is delivered it carries signed links.
const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const settings = env();
  const { store } = await getAdapters();
  const found = await readStatus(store, id, { ...settings, PUBLIC_BASE_URL: serviceBase(settings, req) });
  if (found === null) return Response.json({ error: 'order_not_found', reason: 'There is no order with that id.' }, { status: 404, headers: NO_STORE });
  return Response.json(found.status, { headers: NO_STORE });
}
