/**
 * SSE endpoint: streams robot health states every 15s.
 * GET /api/opentrons-lab/robots/health-stream
 */
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { subscribeHealth, startPoller } from '$lib/server/opentrons/health-poller';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');

	startPoller();

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const unsubscribe = subscribeHealth((states) => {
				try {
					const data = JSON.stringify(states);
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
				} catch {
					// Controller may be closed
				}
			});

			// Store cleanup for cancel
			(controller as any).__cleanup = unsubscribe;
		},
		cancel(controller) {
			const cleanup = (controller as any).__cleanup;
			if (typeof cleanup === 'function') cleanup();
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		},
	});
};
