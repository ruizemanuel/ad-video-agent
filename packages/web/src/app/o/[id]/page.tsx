// The order page, /o/<id>: where a person lands after paying and comes back to by the link. The link is the order's
// credential, as with the status route: it takes nothing but the id. The server reads the order the way the status
// route does, without calling it, and the view in the browser follows it from there.
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getAdapters } from '../../../adapters';
import { env } from '../../../env';
import { readStatus } from '../../../payments/orders';
import { ORDER_PAGE } from '../../../site/copy';
import { OrderView } from '../../../site/OrderView';

// An order changes as it is made, and a delivered one carries signed links: nothing of it is kept.
export const dynamic = 'force-dynamic';

// The link is for whoever has it, not for a search.
export const metadata: Metadata = { title: ORDER_PAGE.title, robots: { index: false, follow: false } };

/** The address the page was asked at, where the service is not told its own (local runs). */
async function askedOrigin(): Promise<string> {
  const asked = await headers();
  return `${asked.get('x-forwarded-proto') ?? 'http'}://${asked.get('host') ?? 'localhost'}`;
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const settings = env();
  const { store } = await getAdapters();
  const base = settings.PUBLIC_BASE_URL ?? (await askedOrigin());
  const found = await readStatus(store, id, { LINK_SIGNING_SECRET: settings.LINK_SIGNING_SECRET, PUBLIC_BASE_URL: base });
  if (found === null) notFound();
  const { order, status } = found;
  return (
    <OrderView
      initial={status}
      audio={order.request.audio === 'none' ? 'none' : 'music'}
      site={new URL(order.request.url).host}
      siteUrl={order.request.url}
      shortId={order.id.slice('ord_'.length, 'ord_'.length + 8)}
      link={`${base}/o/${order.id}`}
    />
  );
}
