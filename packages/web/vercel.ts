import type { VercelConfig } from '@vercel/config/v1';

// Vercel calls these routes with `Authorization: Bearer <CRON_SECRET>`, which the routes require. Times are UTC.
export const config: VercelConfig = {
  crons: [
    // Starts what was settled but never reported, and gives up on what can no longer settle.
    { path: '/api/cron/reconcile', schedule: '*/10 * * * *' },
    // Expires the orders that are 30 days old and deletes their files.
    { path: '/api/cron/cleanup', schedule: '0 4 * * *' },
  ],
};
