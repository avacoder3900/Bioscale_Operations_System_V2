/**
 * Generic robot relay — the queue line for the browser robot-client (OT2-TAILNET-5 S10a).
 * POST /api/opentrons-lab/robots/:id/relay   Body: { method, path, body? }
 *   → the robot's status + JSON body (one kind:'http' queue command on Vercel)
 *
 * GET needs manufacturing:read; POST/PATCH/DELETE need manufacturing:write and
 * write an AuditLog row ('robot_relay'). Logic: $lib/server/opentrons/relay.ts.
 */
import type { RequestHandler } from './$types';
import { handleRelay } from '$lib/server/opentrons/relay';

export const POST: RequestHandler = (event) => handleRelay(event);

export const config = { maxDuration: 60 };
