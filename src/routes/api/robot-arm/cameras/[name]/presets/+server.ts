/**
 * Arm camera setting presets, for the Vision tab's camera settings panel.
 *
 *   GET  ?archived=1                     → { presets: PresetSummary[] }
 *   POST { save: { name, conditions?, notes?, kind?, values? } }
 *          values omitted = capture the camera's current values from the Pi
 *   POST { apply: id }                   → writes the preset to the camera (remembered on the Pi)
 *   POST { archive: id } / { restore: id }
 *        → { preset, result? }
 *
 * Reads need manufacturing:read, writes manufacturing:write; every write is
 * audit-logged in $lib/server/robot-arm-camera-presets. A Pi that cannot be
 * reached makes save-from-camera and apply fail with the reason as a 502
 * (no upstream text); the stored presets are always listable.
 */
import { error, json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { applyPreset, archivePreset, listPresets, savePreset } from '$lib/server/robot-arm-camera-presets';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	if (!params.name) error(400, 'Camera name required');
	const presets = await listPresets(params.name, { includeArchived: url.searchParams.get('archived') === '1' });
	return json({ presets }, { headers: { 'Cache-Control': 'no-store' } });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const name = params.name;
	if (!name) error(400, 'Camera name required');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') error(400, 'Body must be a JSON object');
	const user = { _id: locals.user._id, username: locals.user.username };
	const headers = { 'Cache-Control': 'no-store' };

	try {
		if (body.save && typeof body.save === 'object') {
			const preset = await savePreset(user, name, body.save as any);
			return json({ preset }, { headers });
		}
		if (typeof body.apply === 'string') {
			const r = await applyPreset(user, name, body.apply);
			return json({ preset: r.preset, result: r.result }, { headers });
		}
		if (typeof body.archive === 'string') return json({ preset: await archivePreset(user, name, body.archive, true) }, { headers });
		if (typeof body.restore === 'string') return json({ preset: await archivePreset(user, name, body.restore, false) }, { headers });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Validation and "not found" are the caller's problem; anything from the Pi is a 502 without its text.
		if (/^robot-arm \d{3}|fetch failed|Could not read the camera/.test(msg)) {
			console.error(`[arm-camera] preset action on "${name}" failed:`, msg);
			error(502, 'The arm camera could not be reached');
		}
		error(400, msg);
	}
	error(400, 'Body needs one of: save, apply, archive, restore');
};
