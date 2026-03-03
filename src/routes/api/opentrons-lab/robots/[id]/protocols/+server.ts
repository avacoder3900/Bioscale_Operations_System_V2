/**
 * Protocol management — List / Upload.
 * GET  /api/opentrons-lab/robots/:id/protocols
 * POST /api/opentrons-lab/robots/:id/protocols
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot, robotBaseUrl } from '$lib/server/opentrons/proxy';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		const res = await fetch(`${robotBaseUrl(robot)}/protocols`, {
			headers: { 'opentrons-version': '3' }
		});
		const data = await res.json();
		return json(data);
	} catch (e) {
		console.error('[API] list protocols error:', e instanceof Error ? e.message : e);
		error(502, 'Failed to reach robot');
	}
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const formData = await request.formData();
	const file = formData.get('protocolFile') as File | null;
	if (!file) error(400, 'protocolFile is required');

	try {
		// Forward multipart file upload directly to the robot
		const robotForm = new FormData();
		robotForm.append('files', file, file.name);

		const res = await fetch(`${robotBaseUrl(robot)}/protocols`, {
			method: 'POST',
			headers: { 'opentrons-version': '3' },
			body: robotForm
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			error(502, (body as any).message ?? `Robot returned ${res.status}`);
		}

		const data = await res.json();
		return json(data, { status: 201 });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] upload protocol error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to upload protocol');
	}
};
