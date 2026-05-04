/**
 * Vercel Cron entry point for the mocreo gateway heartbeat (every 30 min).
 * See src/lib/server/services/mocreo-heartbeat.ts for the lifecycle.
 */
import type { RequestHandler } from './$types';
import { runMocreoHeartbeat } from '$lib/server/services/mocreo-heartbeat';

export const GET: RequestHandler = async ({ request, url }) => runMocreoHeartbeat(request, url);
export const POST: RequestHandler = async ({ request, url }) => runMocreoHeartbeat(request, url);
