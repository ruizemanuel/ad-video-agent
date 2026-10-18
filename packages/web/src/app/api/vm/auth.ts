// What both VM routes share: nothing here is for a cache to keep, and every call has to carry the permit of an order.
import type { Order, OrderStore } from '../../../ports';
import { orderForVmRequest } from '../../../vm/token';

export const NO_STORE = { 'cache-control': 'no-store' };

export const refuse = (status: number, error: string, headers: Record<string, string> = {}): Response =>
  Response.json({ error }, { status, headers: { ...NO_STORE, ...headers } });

/** The order the call is for, or the 401 to answer with. It says nothing of why: a bad permit and an expired one look alike. */
export async function authenticate(req: Request, store: Pick<OrderStore, 'orderByVmTokenHash'>): Promise<{ order: Order } | { refusal: Response }> {
  const order = await orderForVmRequest(req, store, new Date());
  if (order === null) return { refusal: refuse(401, 'unauthorized', { 'www-authenticate': 'Bearer' }) };
  return { order };
}
