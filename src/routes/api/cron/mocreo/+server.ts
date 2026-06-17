/**
 * Fresh Vercel Cron entry point for the mocreo probe sync.
 *
 * The historical path /api/mocreo/sync had persistent cron registration
 * issues on Vercel — the Cron Jobs UI kept showing the old once-daily
 * schedule even after the vercel.json fix, and manual "Run" worked but
 * scheduled fires never did. Registering the cron against a brand-new
 * URL forces Vercel to create a fresh cron entry with no stale state.
 *
 * /api/mocreo/sync is kept alive for the openclaw worker + manual
 * curl / sync-now scripts that still point at it.
 */
import type { RequestHandler } from './$types';
import { runMocreoSync } from '$lib/server/services/mocreo-sync';

export const GET: RequestHandler = async ({ request, url }) => runMocreoSync(request, url);
export const POST: RequestHandler = async ({ request, url }) => runMocreoSync(request, url);
