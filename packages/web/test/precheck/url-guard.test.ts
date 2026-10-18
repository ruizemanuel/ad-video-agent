import { describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, UrlRejected, type LookupFn } from '../../src/precheck/url-guard';

const publicDns: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const answers =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('assertPublicUrl', () => {
  it('rejects private, loopback, link-local and metadata targets', async () => {
    for (const u of ['http://127.0.0.1', 'http://10.0.0.5', 'http://169.254.169.254/computeMetadata/v1/', 'http://[::1]/', 'http://localhost', 'ftp://x.com', 'https://x.com:8443'])
      await expect(assertPublicUrl(u)).rejects.toThrow(UrlRejected);
    await expect(assertPublicUrl('https://evil.example', async () => [{ address: '10.1.1.1', family: 4 }])).rejects.toThrow(UrlRejected);
  });

  it('rejects every address inside the private ranges, written any way the URL allows', async () => {
    const lookup = vi.fn(publicDns);
    for (const host of [
      '0.0.0.0',
      '0.255.255.255',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
      // The same loopback address, as a number, in hex, and short.
      '2130706433',
      '0x7f.0.0.1',
      '127.1',
      '[::]',
      '[fc00::1]',
      '[fdff:ffff::1]',
      '[fe80::1]',
      '[febf::1]',
      '[fec0::1]',
      '[ff02::1]',
      // IPv4 inside IPv6.
      '[::127.0.0.1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:10.0.0.1]',
      '[::ffff:a9fe:a9fe]',
      '[64:ff9b::a00:1]',
      '[2002:a00:1::1]',
    ]) {
      await expect(assertPublicUrl(`http://${host}/`, lookup), host).rejects.toMatchObject({ code: 'private_address' });
    }
    // An address is not looked up: it says what it is.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts public addresses next to the private ranges', async () => {
    for (const host of ['9.255.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1', '169.253.255.255', '169.255.0.1', '172.15.255.255', '172.32.0.1', '192.167.255.255', '192.169.0.1', '223.255.255.255', '[2606:4700:4700::1111]', '[::ffff:8.8.8.8]', '[fbff::1]', '[2a00:1450:4009::200e]']) {
      const url = await assertPublicUrl(`https://${host}/`, async () => {
        throw new Error('an address needs no lookup');
      });
      expect(url.protocol, host).toBe('https:');
    }
  });

  it('rejects the names that mean this machine or the inside of a network, with or without a final dot', async () => {
    const lookup = vi.fn(publicDns);
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'api.localhost', 'printer.local', 'printer.local.', 'metadata.google.internal', 'a.b.internal.']) {
      await expect(assertPublicUrl(`http://${host}/`, lookup), host).rejects.toMatchObject({ code: 'host' });
    }
    expect(lookup).not.toHaveBeenCalled();
    // Only the end of the name counts.
    await expect(assertPublicUrl('https://localhost-shop.example', publicDns)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://internal.example', publicDns)).resolves.toBeInstanceOf(URL);
  });

  it('names why it said no', async () => {
    const lookup = answers('8.8.8.8');
    await expect(assertPublicUrl('', lookup)).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(assertPublicUrl('not a url', lookup)).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(assertPublicUrl('https://', lookup)).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(assertPublicUrl('ftp://x.com/file', lookup)).rejects.toMatchObject({ code: 'scheme' });
    await expect(assertPublicUrl('file:///etc/passwd', lookup)).rejects.toMatchObject({ code: 'scheme' });
    await expect(assertPublicUrl('javascript:alert(1)', lookup)).rejects.toMatchObject({ code: 'scheme' });
    await expect(assertPublicUrl('https://user:secret@x.com', lookup)).rejects.toMatchObject({ code: 'credentials' });
    await expect(assertPublicUrl('https://user@x.com', lookup)).rejects.toMatchObject({ code: 'credentials' });
    await expect(assertPublicUrl('http://x.com:8080', lookup)).rejects.toMatchObject({ code: 'port' });
    await expect(assertPublicUrl('https://x.com:22', lookup)).rejects.toMatchObject({ code: 'port' });
    await expect(assertPublicUrl('http://localhost', lookup)).rejects.toMatchObject({ code: 'host' });
    await expect(assertPublicUrl('http://127.0.0.1', lookup)).rejects.toMatchObject({ code: 'private_address' });
    await expect(assertPublicUrl('https://x.com', answers('192.168.0.9'))).rejects.toMatchObject({ code: 'private_address' });
  });

  it('writes a message a person can read, without protocol words', async () => {
    const error = await assertPublicUrl('http://169.254.169.254/', publicDns).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UrlRejected);
    expect((error as UrlRejected).message).toMatch(/private|internal/i);
    expect((error as UrlRejected).message).not.toMatch(/SSRF|169\.254/);
  });

  it('takes the standard ports, spelled out or not', async () => {
    await expect(assertPublicUrl('http://x.com:80/a', publicDns)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://x.com:443/a', publicDns)).resolves.toBeInstanceOf(URL);
    // Not the usual port for the scheme, but one of the two.
    await expect(assertPublicUrl('https://x.com:80/a', publicDns)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://x.com:443/a', publicDns)).resolves.toBeInstanceOf(URL);
  });

  it('looks the name up and rejects it when any answer is private', async () => {
    await expect(assertPublicUrl('https://evil.example', answers('93.184.216.34', '10.1.1.1'))).rejects.toMatchObject({ code: 'private_address' });
    await expect(assertPublicUrl('https://evil.example', answers('2606:4700::1', 'fd00::5'))).rejects.toMatchObject({ code: 'private_address' });
    await expect(assertPublicUrl('https://evil.example', answers('::ffff:127.0.0.1'))).rejects.toMatchObject({ code: 'private_address' });
  });

  it('gives back the parsed address when every answer is public', async () => {
    const lookup = vi.fn(answers('93.184.216.34', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'));
    const url = await assertPublicUrl('https://Tiendita.Example/demo?x=1#top', lookup);
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe('https://tiendita.example/demo?x=1#top');
    expect(lookup).toHaveBeenCalledExactlyOnceWith('tiendita.example');
  });

  it('says the name does not exist when the lookup fails or finds nothing', async () => {
    const failing: LookupFn = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.example'), { code: 'ENOTFOUND' });
    };
    await expect(assertPublicUrl('https://nope.example', failing)).rejects.toMatchObject({ code: 'unresolvable' });
    await expect(assertPublicUrl('https://nope.example', async () => [])).rejects.toMatchObject({ code: 'unresolvable' });
    // An answer that is not an address at all is not trusted either.
    await expect(assertPublicUrl('https://odd.example', answers('not-an-ip'))).rejects.toMatchObject({ code: 'unresolvable' });
  });
});
