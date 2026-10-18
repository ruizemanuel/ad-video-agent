import { describe, expect, it, vi } from 'vitest';
import { metadataBlocked } from '../src/capture';

describe('metadataBlocked', () => {
  it('asks the metadata server for its root with the Google header and gives it 3 seconds', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));

    await metadataBlocked(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('http://169.254.169.254/computeMetadata/v1/', expect.objectContaining({ headers: { 'Metadata-Flavor': 'Google' } }));
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('is true when the call fails or times out: the VM cannot reach the server', async () => {
    expect(await metadataBlocked(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))).toBe(true);
    expect(await metadataBlocked(vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timed out', 'TimeoutError')))).toBe(true);
  });

  // Whatever the server answers, even a refusal, the VM reached it.
  it.each([200, 403, 404])('is false when the server answers, even with a %i', async (status) => {
    expect(await metadataBlocked(vi.fn<typeof fetch>(async () => new Response('', { status })))).toBe(false);
  });
});
