// GET /v1/offer: what an order costs now, free, for the page and for anyone who asks: the price in USDT or USDC on
// Celo and, while the first-video promo is on, its price and how many of its slots are left (0 once they are all held).
// The price a request is actually offered is the one in the 402 of POST /v1/videos.
import { getAdapters } from '../../../adapters';
import { env } from '../../../env';
import { formatPrice, PROMO_PRICE_ATOMIC } from '../../../payments/x402';

// The slots left change with every promo order.
const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(): Promise<Response> {
  const settings = env();
  let promo: { price: string; left: number } | null = null;
  if (settings.PROMO_SLOTS > 0) {
    const { store } = await getAdapters();
    promo = { price: formatPrice(PROMO_PRICE_ATOMIC), left: Math.max(0, settings.PROMO_SLOTS - (await store.promoSlotsUsed())) };
  }
  return Response.json({ price: formatPrice(settings.PRICE_ATOMIC), assets: ['USDT', 'USDC'], promo }, { headers: NO_STORE });
}
