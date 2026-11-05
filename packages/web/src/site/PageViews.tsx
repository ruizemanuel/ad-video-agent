'use client';
// Vercel Web Analytics, page views only: how many open the home, and how many of them go on to an order. No cookie; each
// address goes through analyticsUrl first.
import { Analytics } from '@vercel/analytics/next';
import { analyticsUrl } from './analytics';

export function PageViews() {
  return <Analytics beforeSend={(event) => ({ ...event, url: analyticsUrl(event.url) })} />;
}
