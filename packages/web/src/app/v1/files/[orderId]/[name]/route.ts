// GET /v1/files/<orderId>/<name>?exp=<unix>&sig=<hex>: a delivery link. If the signature and the time are good and
// the name is a deliverable of the order, it redirects (302) to a 10-minute presigned read of the blob. The links
// live 30 days; the presign lives only as long as the download needs to start. With download=1 (the page's download
// buttons), the read makes the browser save the file: the blob is on another origin, where the `download` attribute of
// a link does nothing. download=1 is not signed: it changes only how the file arrives.
import { getAdapters } from '../../../../../adapters';
import { env } from '../../../../../env';
import { verifyFileLink } from '../../../../../links';

const PRESIGN_MINUTES = 10;
// Only whole unix seconds, written the one way this service writes them: "1.8e9" and "01800000000" are the same
// number, but not the same link.
const UNIX_SECONDS = /^(0|[1-9][0-9]{0,14})$/;

// Nothing here is for a cache to keep: the redirect carries a signature, and the answers change with the time.
const NO_STORE = { 'cache-control': 'no-store' };

const refuse = (status: number, error: string): Response => Response.json({ error }, { status, headers: NO_STORE });

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string; name: string }> }): Promise<Response> {
  const { orderId, name } = await ctx.params;
  const query = new URL(req.url).searchParams;
  const exp = query.get('exp') ?? '';
  const sig = query.get('sig') ?? '';

  // The signature first, before the database: a link nobody here made learns nothing about which orders exist.
  const verdict = UNIX_SECONDS.test(exp) ? verifyFileLink({ orderId, name, exp: Number(exp), sig }, env().LINK_SIGNING_SECRET, Date.now()) : 'bad-signature';
  if (verdict === 'bad-signature') return refuse(403, 'This download link is not valid.');
  if (verdict === 'expired') return refuse(410, 'This download link has expired.');

  const { store, blob } = await getAdapters();
  const order = await store.getOrder(orderId);
  if (order === null) return refuse(404, 'No such file for this order.');
  // The files are deleted when the order expires, which can be a little before the link would.
  if (order.status === 'expired') return refuse(410, 'The files of this order are no longer available.');
  const deliverable = order.deliverables.find((file) => file.name === name);
  if (deliverable === undefined) return refuse(404, 'No such file for this order.');

  const location = await blob.presignGet(deliverable.path, PRESIGN_MINUTES, { attachment: query.get('download') === '1' });
  return new Response(null, { status: 302, headers: { ...NO_STORE, location } });
}
