// The guard against server-side request forgery. The pre-check fetches an address that a stranger typed, from a server
// that sits inside Vercel's network: it must never be made to read the cloud's metadata service, a private network
// or this machine. The guard accepts an address only if it is http(s) on the usual ports, has no credentials, is not
// a name that means "inside", and every address its name resolves to is a public one.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type UrlRejectedCode = 'invalid_url' | 'scheme' | 'credentials' | 'port' | 'host' | 'private_address' | 'unresolvable';

/** An address the pre-check will not fetch. `message` is for the person who typed it. */
export class UrlRejected extends Error {
  constructor(
    readonly code: UrlRejectedCode,
    message: string,
  ) {
    super(message);
    this.name = 'UrlRejected';
  }
}

/** What `dns.promises.lookup(host, { all: true })` answers. */
export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

// The ranges of addresses that are not on the public internet. An IPv4 address written inside IPv6 (::ffff:10.0.0.1)
// is checked as the IPv4 address it carries.
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, and the cloud metadata service (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const)
  PRIVATE.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], // the unspecified address, loopback (::1) and the IPv4-compatible form (::127.0.0.1)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local, deprecated but still not public
  ['ff00::', 8], // multicast
  ['64:ff9b::', 96], // NAT64: carries any IPv4 address
  ['2002::', 16], // 6to4: carries any IPv4 address
] as const)
  PRIVATE.addSubnet(network, prefix, 'ipv6');

// Names that mean this machine or the inside of a network, whatever they resolve to.
const INSIDE_NAMES = /(^|\.)localhost$|\.local$|\.internal$/;

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  // Something that is not an address cannot be shown to be public.
  return family === 0 || PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The address as a URL, if it may be fetched. Throws UrlRejected, with a `code`, if not. The name is resolved here
 * with `lookup` (the system's resolver by default) and every answer must be public. A fetch resolves the name again,
 * so this is a check made just before it, not a guarantee about the connection.
 */
export async function assertPublicUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejected('invalid_url', 'That is not a valid web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlRejected('scheme', 'Only http and https addresses are accepted.');
  if (url.username !== '' || url.password !== '') throw new UrlRejected('credentials', 'The address must not contain a user name or a password.');
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw new UrlRejected('port', 'Only the standard web ports (80 and 443) are accepted.');

  // The brackets of an IPv6 address are part of the host name, and a final dot does not change the name.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (INSIDE_NAMES.test(host)) throw new UrlRejected('host', 'Private and internal addresses are not accepted.');
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new UrlRejected('private_address', 'That address points to a private or internal network, which is not accepted.');
    return url;
  }

  let answers: Awaited<ReturnType<LookupFn>>;
  try {
    answers = await lookup(host);
  } catch {
    throw new UrlRejected('unresolvable', 'That web address does not exist or does not answer.');
  }
  if (answers.length === 0 || answers.some(({ address }) => isIP(address) === 0)) throw new UrlRejected('unresolvable', 'That web address does not exist or does not answer.');
  if (answers.some(({ address }) => isPrivateAddress(address))) throw new UrlRejected('private_address', 'That address points to a private or internal network, which is not accepted.');
  return url;
}
