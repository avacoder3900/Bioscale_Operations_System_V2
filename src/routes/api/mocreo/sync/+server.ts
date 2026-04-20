import type { RequestHandler } from './$types';
import { runMocreoSync } from '$lib/server/services/mocreo-sync';

// Legacy path — retained for the openclaw worker, sync-now scripts, and
// manual curl invocations. The Vercel Cron registration now lives on the
// fresh /api/cron/mocreo path so Vercel re-registers cleanly.
export const GET: RequestHandler = async ({ request, url }) => runMocreoSync(request, url);
export const POST: RequestHandler = async ({ request, url }) => runMocreoSync(request, url);
