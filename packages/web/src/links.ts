// The delivery links: `GET /v1/files/<orderId>/<name>?exp=<unix>&sig=<hex>`. The signature is an HMAC-SHA256 of
// `${orderId}/${name}/${exp}` under LINK_SIGNING_SECRET, so a link works for one file of one order until `exp` and
// cannot be changed to anything else. The route checks it and redirects to a short-lived presign of the blob.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** `exp` is in unix seconds: the first second the link no longer works. */
export type FileLink = { orderId: string; name: string; exp: number };
export type SignedFileLink = FileLink & { sig: string };

const SIGNATURE = /^[0-9a-f]{64}$/;

const sign = ({ orderId, name, exp }: FileLink, secret: string): string => createHmac('sha256', secret).update(`${orderId}/${name}/${exp}`).digest('hex');

/** The full URL of a delivery link. Refuses what could make two different links sign the same text. */
export function signFileLink(link: FileLink, secret: string, base: string): string {
  const { orderId, name, exp } = link;
  if (orderId === '' || orderId.includes('/')) throw new RangeError('A file link needs an order id with no slash.');
  if (name === '' || name.includes('/')) throw new RangeError('A file link needs a file name with no slash.');
  if (!Number.isSafeInteger(exp) || exp < 0) throw new RangeError(`A file link needs an expiry in whole unix seconds; got ${exp}.`);
  return `${base.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(orderId)}/${encodeURIComponent(name)}?exp=${exp}&sig=${sign(link, secret)}`;
}

/** The signature goes first: a link that was not made here is `bad-signature` whether or not its time has passed. `now` is in ms. */
export function verifyFileLink(link: SignedFileLink, secret: string, now: number): 'ok' | 'expired' | 'bad-signature' {
  if (!SIGNATURE.test(link.sig)) return 'bad-signature';
  if (!timingSafeEqual(Buffer.from(link.sig, 'hex'), Buffer.from(sign(link, secret), 'hex'))) return 'bad-signature';
  return link.exp * 1000 <= now ? 'expired' : 'ok';
}
