import type { VercelConfig } from '@vercel/config/v1';

// Vercel calls these routes with `Authorization: Bearer <CRON_SECRET>`, which the routes require. Times are UTC.
export const config: VercelConfig = {
  crons: [
    // The reconciliation: starts what was settled but never reported, and gives up on what can no longer settle. The
    // Hobby plan only allows crons that run once a day, so the 10-minute clock is the Cloudflare Worker in packages/clock;
    // this daily run is the backstop, should the Worker stop. Its minute is kept off the Worker's (3, 13, 23, ...), though
    // on Hobby Vercel may fire a cron anywhere inside its hour: best effort.
    { path: '/api/cron/reconcile', schedule: '8 3 * * *' },
    // Expires the orders that are 30 days old and deletes their files.
    { path: '/api/cron/cleanup', schedule: '0 4 * * *' },
  ],
};
