/**
 * CALIB-1 deck tuner (manual-delta version).
 *
 * Tune a deck hole's x/y/z from the UI instead of hand-editing the labware JSON.
 * Pick a deck → pick a well → nudge x/y/z; the apply-edit service writes the new
 * coords to Mongo (source of truth, bundled to the robot on next protocol upload)
 * + best-effort to the local Opentrons labware JSON, with full per-hole history.
 *
 * (The live-jog wizard — move the gantry to the hole and jog by hand — is CALIB-0
 * and layers on top of this same apply-edit engine once LAN jog is wired.)
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, LabwareDefinition } from '$lib/server/db';
import { applyDeckEdit, deckEditHistory } from '$lib/server/services/deck-calibration/apply-edit';
import type { PageServerLoad, Actions } from './$types';

const DECK_RE = /(gen4deck|cartridge_deck)/i;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const defs = (await LabwareDefinition.find({}, { loadName: 1, namespace: 1, version: 1 })
		.lean()) as any[];
	const decks = defs
		.filter((d) => DECK_RE.test(d.loadName))
		.map((d) => ({ loadName: d.loadName, namespace: d.namespace ?? '', version: d.version ?? 1 }))
		.sort((a, b) => a.loadName.localeCompare(b.loadName));

	const selected = url.searchParams.get('deck')?.trim() || '';
	let wells: { name: string; x: number; y: number; z: number }[] = [];
	let history: any[] = [];

	if (selected && decks.some((d) => d.loadName === selected)) {
		const def = (await LabwareDefinition.findOne({ loadName: selected }).lean()) as any;
		const wmap = def?.definition?.wells ?? {};
		wells = Object.keys(wmap)
			.map((name) => ({
				name,
				x: Number(wmap[name]?.x ?? 0),
				y: Number(wmap[name]?.y ?? 0),
				z: Number(wmap[name]?.z ?? 0)
			}))
			// natural-ish sort: letter row then numeric column (A1, A2, ... B1, ...)
			.sort((a, b) => {
				const pa = a.name.match(/^([A-Za-z]+)(\d+)$/);
				const pb = b.name.match(/^([A-Za-z]+)(\d+)$/);
				if (pa && pb) {
					if (pa[1] !== pb[1]) return pa[1].localeCompare(pb[1]);
					return Number(pa[2]) - Number(pb[2]);
				}
				return a.name.localeCompare(b.name);
			});
		history = (await deckEditHistory(selected, 100)).map((h) => ({
			wellName: h.wellName,
			delta: h.delta,
			before: h.before,
			after: h.after,
			createdBy: h.createdBy ?? '',
			createdAt: h.createdAt?.toISOString?.() ?? ''
		}));
	}

	return {
		decks,
		selected,
		wells: JSON.parse(JSON.stringify(wells)),
		history: JSON.parse(JSON.stringify(history))
	};
};

export const actions: Actions = {
	applyEdit: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');

		const data = await request.formData();
		const deckLoadName = (data.get('deckLoadName') as string)?.trim() || '';
		const wellName = (data.get('wellName') as string)?.trim() || '';
		const dx = Number(data.get('dx') || 0);
		const dy = Number(data.get('dy') || 0);
		const dz = Number(data.get('dz') || 0);

		if (!deckLoadName) return fail(400, { error: 'Pick a deck' });
		if (!wellName) return fail(400, { error: 'Pick a well' });
		if (![dx, dy, dz].every((n) => Number.isFinite(n))) return fail(400, { error: 'Nudge values must be numbers' });
		if (dx === 0 && dy === 0 && dz === 0) return fail(400, { error: 'Enter a non-zero nudge' });

		try {
			const res = await applyDeckEdit({
				deckLoadName,
				wellName,
				delta: { x: dx, y: dy, z: dz },
				user: { _id: locals.user._id, username: locals.user.username }
			});
			return { success: true, wellName, ...res };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Edit failed' });
		}
	}
};
