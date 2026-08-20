/**
 * Deck Calibration Studio (DECK-CALIBRATION-STUDIO).
 *
 * Graphical deck + jog-to-teach + group apply. Pick a deck (one native Opentrons
 * labware def = all fill holes) and a robot; see every hole at its real x/y;
 * box/click-select a group; jog the OT-2 pipette to a reference hole (maintenance
 * run, same flow as scanner-position teaching) to CAPTURE the real offset; apply
 * that offset to the whole selection. Corrections persist via the apply-edit
 * engine (Mongo source of truth + per-hole history + best-effort lab-Mac mirror)
 * and reach the robot by re-uploading the protocol (corrected labware auto-bundles).
 *
 * Jog itself is driven client-side against the existing maintenance API
 * (/api/opentrons-lab/robots/[id]/maintenance/...). This file owns load + the
 * batch-apply and sync server actions.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	LabwareDefinition,
	OpentronsRobot,
	OpentronProtocol,
	RobotDeckOffset,
	TipCalibratorFixture,
	AuditLog,
	generateId
} from '$lib/server/db';
import {
	applyDeckEditBatch,
	applyDeckEditsPerWell,
	applyDeckDimensionEdit,
	deckEditHistory
} from '$lib/server/services/deck-calibration/apply-edit';
import { getRobot, robotUploadProtocol } from '$lib/server/opentrons/proxy';
import {
	publishDeckVersion,
	rollbackDeckVersion,
	listDeckVersions
} from '$lib/server/services/deck-calibration/deck-versions';
import { isDeckLoadName } from '$lib/server/services/deck-calibration/resolve';
import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';
import { DeckVersion } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

const DECK_RE = /(gen4deck|cartridge_deck)/i;
// The two tube racks + two tip racks used by the wax/reagent protocols (slots 10/11).
const TUBE_RACKS = ['cosmas_and_damian_drybath_tuberack', 'custom_2ml_24_tube_rack'];
const TIP_RACKS = ['cosmasanddamian_96_tiprack_20ul', 'cosmas_and_damian_biotix_96_200ul_tiprack'];
// Default OT-2 slot per labware kind (deck/carriage spans 1-9 from slot 1).
const SLOT_FOR_KIND: Record<string, string> = { deck: '1', tube: '10', tip: '11' };

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const defs = (await LabwareDefinition.find({}, { loadName: 1, namespace: 1, version: 1 }).lean()) as any[];
	const toOpt = (d: any) => ({ loadName: d.loadName, namespace: d.namespace ?? '', version: d.version ?? 1 });
	const decks = defs.filter((d) => DECK_RE.test(d.loadName)).map(toOpt).sort((a, b) => a.loadName.localeCompare(b.loadName));
	const tubeRacks = defs.filter((d) => TUBE_RACKS.includes(d.loadName)).map(toOpt).sort((a, b) => a.loadName.localeCompare(b.loadName));
	const tipRacks = defs.filter((d) => TIP_RACKS.includes(d.loadName)).map(toOpt).sort((a, b) => a.loadName.localeCompare(b.loadName));

	const robotsRaw = (await OpentronsRobot.find({}, { name: 1, robotSide: 1, isActive: 1 }).lean()) as any[];
	const robots = robotsRaw
		.map((r) => ({ _id: String(r._id), name: r.name ?? String(r._id), robotSide: r.robotSide ?? null, isActive: r.isActive !== false }))
		.sort((a, b) => a.name.localeCompare(b.name));

	// What kind of labware are we calibrating: deck | tube | tip | calibrator.
	// The calibrator is a fixed fixture (not labware) — no options, no wells.
	const kind = (url.searchParams.get('kind')?.trim() || 'deck') as 'deck' | 'tube' | 'tip' | 'calibrator';
	const optionsForKind = kind === 'tube' ? tubeRacks : kind === 'tip' ? tipRacks : kind === 'calibrator' ? [] : decks;
	const selected = kind === 'calibrator' ? '' : (url.searchParams.get('deck')?.trim() || (optionsForKind[0]?.loadName ?? ''));
	const slot = SLOT_FOR_KIND[kind] ?? '1';

	let wells: { name: string; x: number; y: number; z: number }[] = [];
	let dimensions = { x: 0, y: 0, z: 0 };
	let history: any[] = [];
	let editedWells: string[] = [];

	if (selected && optionsForKind.some((d) => d.loadName === selected)) {
		const def = (await LabwareDefinition.findOne({ loadName: selected }).lean()) as any;
		const wmap = def?.definition?.wells ?? {};
		const dim = def?.definition?.dimensions ?? {};
		dimensions = { x: Number(dim.xDimension ?? 0), y: Number(dim.yDimension ?? 0), z: Number(dim.zDimension ?? 0) };
		wells = Object.keys(wmap).map((name) => ({
			name,
			x: Number(wmap[name]?.x ?? 0),
			y: Number(wmap[name]?.y ?? 0),
			z: Number(wmap[name]?.z ?? 0)
		}));
		const hist = await deckEditHistory(selected, 200);
		editedWells = Array.from(new Set(hist.map((h: any) => h.wellName)));
		history = hist.slice(0, 100).map((h: any) => ({
			wellName: h.wellName, delta: h.delta, before: h.before, after: h.after,
			createdBy: h.createdBy ?? '', createdAt: h.createdAt?.toISOString?.() ?? ''
		}));
	}

	// Per-robot calibration: all global offsets + tip-calibrator fixtures (client picks by robot).
	const robotOffsets = (await RobotDeckOffset.find({}).lean() as any[]).map((o) => ({
		robotId: String(o.robotId), offset: o.offset ?? { x: 0, y: 0, z: 0 }, isReference: !!o.isReference,
		capturedAt: o.capturedAt?.toISOString?.() ?? null, note: o.note ?? ''
	}));
	const calibrators = (await TipCalibratorFixture.find({}).lean() as any[]).map((c) => ({
		robotId: String(c.robotId), position: c.position ?? { x: 125.181, y: 173.247, z: 34.491 },
		zCalWax: c.zCalWax ?? 34.491, zCalReagent: c.zCalReagent ?? 40.8
	}));

	// Version history for the selected deck (empty for racks — only decks are versioned).
	const versions = selected && isDeckLoadName(selected) ? await listDeckVersions(selected, 50) : [];
	const selectedDef = selected
		? ((await LabwareDefinition.findOne({ loadName: selected })
				.select('version lastPublishedVersion hasUnpublishedEdits')
				.lean()) as any)
		: null;

	return {
		kind,
		versions: JSON.parse(JSON.stringify(versions)),
		liveVersion: selectedDef?.version ?? null,
		lastPublishedVersion: selectedDef?.lastPublishedVersion ?? null,
		hasUnpublishedEdits: !!selectedDef?.hasUnpublishedEdits,
		decks, tubeRacks, tipRacks,
		robots,
		selected,
		slot,
		wells: JSON.parse(JSON.stringify(wells)),
		dimensions,
		editedWells,
		history: JSON.parse(JSON.stringify(history)),
		robotOffsets: JSON.parse(JSON.stringify(robotOffsets)),
		calibrators: JSON.parse(JSON.stringify(calibrators))
	};
};

export const actions: Actions = {
	/** Apply one delta to a group of wells (the core group-calibration write). */
	applyBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');

		const data = await request.formData();
		const deckLoadName = (data.get('deckLoadName') as string)?.trim() || '';
		const dx = Number(data.get('dx') || 0);
		const dy = Number(data.get('dy') || 0);
		const dz = Number(data.get('dz') || 0);
		const robotId = (data.get('robotId') as string)?.trim() || null;
		let wellNames: string[] = [];
		try {
			wellNames = JSON.parse((data.get('wellNames') as string) || '[]');
		} catch {
			return fail(400, { error: 'wellNames must be a JSON array' });
		}

		if (!deckLoadName) return fail(400, { error: 'Pick a deck' });
		if (!Array.isArray(wellNames) || wellNames.length === 0) return fail(400, { error: 'Select at least one hole' });
		if (![dx, dy, dz].every((n) => Number.isFinite(n))) return fail(400, { error: 'Offset values must be numbers' });
		if (dx === 0 && dy === 0 && dz === 0) return fail(400, { error: 'Enter a non-zero offset' });

		try {
			const res = await applyDeckEditBatch({
				deckLoadName,
				wellNames,
				delta: { x: dx, y: dy, z: dz },
				user: { _id: locals.user._id, username: locals.user.username },
				robotId
			});
			// Batch applies are all-or-nothing (partial application tears the group
			// geometry apart) — surface a full rejection as a loud error, not a
			// success with applied=0.
			if (res.applied === 0 && res.failed.length) {
				const head = res.failed.slice(0, 3).map((f) => `${f.wellName}: ${f.reason}`).join('; ');
				const more = res.failed.length > 3 ? ` (+${res.failed.length - 3} more)` : '';
				return fail(400, {
					error: `Nothing applied — the whole batch was rejected so the group keeps its geometry. ${head}${more}. Re-capture with a delta that fits every selected well.`
				});
			}
			return { success: true, action: 'applyBatch', ...res };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Batch apply failed' });
		}
	},

	/**
	 * Apply a DIFFERENT delta per well in one write (grid alignment — "Align to
	 * anchor hole"). Body: edits = JSON [{ wellName, dx, dy, dz }].
	 */
	applyPerWell: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');

		const data = await request.formData();
		const deckLoadName = (data.get('deckLoadName') as string)?.trim() || '';
		const robotId = (data.get('robotId') as string)?.trim() || null;
		let rawEdits: { wellName: string; dx: number; dy: number; dz: number }[] = [];
		try {
			rawEdits = JSON.parse((data.get('edits') as string) || '[]');
		} catch {
			return fail(400, { error: 'edits must be a JSON array' });
		}

		if (!deckLoadName) return fail(400, { error: 'Pick a deck' });
		if (!Array.isArray(rawEdits) || rawEdits.length === 0) return fail(400, { error: 'No edits to apply' });
		const edits = rawEdits
			.filter((e) => e?.wellName && [e.dx, e.dy, e.dz].every((v) => Number.isFinite(Number(v))))
			.map((e) => ({ wellName: String(e.wellName), delta: { x: Number(e.dx), y: Number(e.dy), z: Number(e.dz) } }));
		if (edits.length === 0) return fail(400, { error: 'No valid edits to apply' });

		try {
			const res = await applyDeckEditsPerWell({
				deckLoadName,
				edits,
				user: { _id: locals.user._id, username: locals.user.username },
				robotId
			});
			return { success: true, action: 'applyPerWell', ...res };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Per-well apply failed' });
		}
	},

	/**
	 * Set the labware HEIGHT (dimensions.zDimension).
	 *
	 * The one geometry field that had no write path, which meant a deck could only
	 * ever declare 12.7mm. It is not just this app's edit ceiling: the OT-2 plans
	 * its own default arcs and collision checks from zDimension, so a stale height
	 * under a raised deck tells the robot it may travel low. The service rejects a
	 * height that would orphan a hole or leave no tip clearance — surface its
	 * message verbatim, it names the deficit in mm.
	 */
	setDeckHeight: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');

		const data = await request.formData();
		const deckLoadName = (data.get('deckLoadName') as string)?.trim() || '';
		const zDimension = Number(data.get('zDimension'));
		const robotId = (data.get('robotId') as string)?.trim() || null;

		if (!deckLoadName) return fail(400, { error: 'Pick a deck' });
		if (!Number.isFinite(zDimension)) return fail(400, { error: 'Height must be a number' });

		try {
			const res = await applyDeckDimensionEdit({
				deckLoadName,
				zDimension,
				user: { _id: locals.user._id, username: locals.user.username },
				robotId
			});
			return { success: true, action: 'setDeckHeight', ...res };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Height edit failed' });
		}
	},

	/** PRD 2/3: save the tip-calibrator fixture position (jog → save) per robot. */
	saveCalibrator: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim();
		const x = Number(data.get('x')), y = Number(data.get('y')), z = Number(data.get('z'));
		if (!robotId) return fail(400, { error: 'Pick a robot' });
		if (![x, y, z].every(Number.isFinite)) return fail(400, { error: 'x/y/z must be numbers' });

		// Global offsets are retired (2026-08-19). The deck definition is the only
		// source of hole positions, and the per-tip probe is the only correction on
		// top of it. A non-zero global offset moves all 576 holes plus the tube and
		// tip racks, so it silently double-counts geometry the Studio already tuned
		// — that is what caused the 07-08 deck-004 misses on B14 and pushed R04's
		// wax 1mm right on 08-19. Storing zero is still allowed so the row can stay
		// as an explicit "no offset" record.
		if (x !== 0 || y !== 0 || z !== 0) {
			return fail(400, {
				error:
					`Global robot offsets are retired — this would move every hole on the deck, ` +
					`not just the one you measured. The deck definition is the single source of ` +
					`truth for hole positions; correct the hole in the Studio instead, and let the ` +
					`per-tip calibrator handle tip-to-tip variation.`
			});
		}
		await TipCalibratorFixture.updateOne(
			{ robotId },
			{ $set: { position: { x, y, z }, capturedBy: { _id: locals.user._id, username: locals.user.username }, capturedAt: new Date() }, $setOnInsert: { _id: generateId() } },
			{ upsert: true }
		);
		await AuditLog.create({ _id: generateId(), tableName: 'tip_calibrator_fixtures', recordId: robotId, action: 'save_calibrator', newData: { x, y, z }, changedAt: new Date(), changedBy: locals.user?.username });
		return { success: true, action: 'saveCalibrator' };
	},

	/** PRD 5: save a robot's GLOBAL deck offset (applies to all labware at fill time). */
	saveRobotOffset: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim();
		const x = Number(data.get('x')), y = Number(data.get('y')), z = Number(data.get('z'));
		const isReference = (data.get('isReference') as string) === 'true';
		if (!robotId) return fail(400, { error: 'Pick a robot' });
		if (![x, y, z].every(Number.isFinite)) return fail(400, { error: 'x/y/z must be numbers' });
		if (isReference) await RobotDeckOffset.updateMany({ robotId: { $ne: robotId } }, { $set: { isReference: false } });
		await RobotDeckOffset.updateOne(
			{ robotId },
			{ $set: { offset: { x, y, z }, isReference, capturedBy: { _id: locals.user._id, username: locals.user.username }, capturedAt: new Date() }, $setOnInsert: { _id: generateId() } },
			{ upsert: true }
		);
		await AuditLog.create({ _id: generateId(), tableName: 'robot_deck_offsets', recordId: robotId, action: 'save_robot_offset', newData: { x, y, z, isReference }, changedAt: new Date(), changedBy: locals.user?.username });
		return { success: true, action: 'saveRobotOffset' };
	},

	/**
	 * Freeze the selected deck's current geometry as a new immutable version.
	 *
	 * Separate from Sync so a deck can be snapshotted at a known-good moment
	 * without also pushing it to a robot. No-ops when nothing changed since the
	 * last version, so pressing it twice cannot litter the history.
	 */
	publishDeck: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const deckLoadName = (data.get('deckLoadName') as string)?.trim() || '';
		const note = (data.get('note') as string)?.trim() || '';
		if (!deckLoadName) return fail(400, { error: 'deckLoadName is required' });
		if (!isDeckLoadName(deckLoadName)) {
			return fail(400, { error: `"${deckLoadName}" is not a cartridge deck — only decks are versioned.` });
		}

		try {
			const r = await publishDeckVersion({ deckLoadName, user: locals.user, note: note || undefined });
			return { success: true, action: 'publishDeck', ...r };
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'Publish failed' });
		}
	},

	/**
	 * Restore an earlier version of a deck.
	 *
	 * The old snapshot is never mutated — its geometry is republished as a NEW
	 * higher version, so a version number always means exactly one geometry.
	 * Requires the deck's loadName typed back as confirmation, because this
	 * rewrites every hole on the deck at once.
	 */
	rollbackDeck: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const deckLoadName = (data.get('deckLoadName') as string)?.trim() || '';
		const toVersion = Number(data.get('toVersion'));
		const confirm = (data.get('confirm') as string)?.trim() || '';
		const note = (data.get('note') as string)?.trim() || '';

		if (!deckLoadName) return fail(400, { error: 'deckLoadName is required' });
		if (!Number.isInteger(toVersion) || toVersion < 1) {
			return fail(400, { error: 'toVersion must be a published version number' });
		}
		if (confirm !== deckLoadName) {
			return fail(400, {
				error: `Type the deck's loadName (${deckLoadName}) to confirm — rollback rewrites every hole on the deck.`
			});
		}

		try {
			const r = await rollbackDeckVersion({
				deckLoadName,
				toVersion,
				user: locals.user,
				note: note || undefined
			});
			return {
				success: true,
				action: 'rollbackDeck',
				...r,
				detail: `${r.detail}. Sync to the robot to put it on the deck.`
			};
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'Rollback failed' });
		}
	},

	/**
	 * Push the corrected deck to a robot by re-uploading the protocol — robotUploadProtocol
	 * bundles the now-corrected labware defs from Mongo. Needs the protocol .py bytes,
	 * which BIMS only has if a protocol was stored (OpentronProtocol.fileContent). If
	 * none is stored, the corrected deck is still in Mongo + the lab-Mac mirror; the
	 * operator just re-uploads the .py via Robots → Protocols and the deck rides along.
	 */
	sync: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim() || '';
		const which = (data.get('which') as string)?.trim() || 'both'; // wax | reagent | both
		if (!robotId) return fail(400, { error: 'Pick a robot to sync to' });

		const robot = await getRobot(robotId);
		if (!robot) return fail(404, { error: 'Robot not found' });

		const types = which === 'wax' ? ['wax-filling'] : which === 'reagent' ? ['reagent-filling'] : ['wax-filling', 'reagent-filling'];
		const results: { processType: string; ok: boolean; detail: string }[] = [];

		// Freeze every deck carrying unpublished jog edits BEFORE uploading, so the
		// bundle the robot receives is a numbered version we can name later, and so
		// the definition arrives under a NEW namespace/loadName/version URI. That
		// fresh identity is what stops a robot reusing a definition it already
		// holds — Opentrons keys registered definitions to that triple, so pushing
		// changed geometry at an unchanged version is how stale coordinates survive
		// a "successful" sync.
		// Gated per robot: bumping a deck's version changes the identity every robot
		// resolves it by, so it only happens when syncing to an opted-in robot.
		const dirty = isHardenedRobot(robot)
			? ((await LabwareDefinition.find({ hasUnpublishedEdits: true })
					.select('loadName')
					.lean()) as any[])
			: [];
		const publishedVersions: { deckLoadName: string; version: number }[] = [];
		for (const d of dirty.filter((x) => isDeckLoadName(String(x.loadName)))) {
			try {
				const r = await publishDeckVersion({
					deckLoadName: String(d.loadName),
					user: locals.user,
					note: `sync to ${robot.name ?? robotId}`
				});
				if (r.published) publishedVersions.push({ deckLoadName: String(d.loadName), version: r.version });
				results.push({ processType: String(d.loadName), ok: true, detail: r.detail });
			} catch (e) {
				results.push({
					processType: String(d.loadName),
					ok: false,
					detail: `Could not freeze a version: ${e instanceof Error ? e.message : 'unknown'}`
				});
			}
		}

		for (const pt of types) {
			const proto = (await OpentronProtocol.findOne({ processType: pt, isActive: true }).sort({ createdAt: -1 }).lean()) as any;
			if (!proto?.fileContent) {
				results.push({ processType: pt, ok: false, detail: 'No stored protocol .py in BIMS — re-upload it via Robots → Protocols to push the corrected deck.' });
				continue;
			}
			try {
				const bytes = new TextEncoder().encode(proto.fileContent);
				const uploaded = await robotUploadProtocol(robot, proto.fileName ?? `${pt}.py`, bytes);
				await OpentronsRobot.updateOne({ _id: robotId }, { $pull: { protocols: { protocolType: pt } } });
				await OpentronsRobot.updateOne(
					{ _id: robotId },
					{ $push: { protocols: {
						_id: generateId(),
						opentronsProtocolId: uploaded.opentronsProtocolId,
						protocolName: proto.fileName ?? `${pt}.py`,
						protocolType: pt,
						parametersSchema: uploaded.parametersSchema ?? null,
						analysisStatus: uploaded.analysisStatus,
						labwareDefinitions: uploaded.labwareDefinitions ?? null,
						pipettesRequired: uploaded.pipettesRequired ?? null,
						uploadedBy: locals.user.username,
						createdAt: new Date(),
						updatedAt: new Date()
					} } }
				);
				for (const pv of publishedVersions) {
					await DeckVersion.updateOne(
						{ deckLoadName: pv.deckLoadName, version: pv.version },
						{
							$push: {
								publishedToRobots: {
									robotId: String(robotId),
									robotName: robot.name ?? null,
									opentronsProtocolId: uploaded.opentronsProtocolId,
									at: new Date()
								}
							}
						}
					);
				}
				results.push({ processType: pt, ok: true, detail: `Re-uploaded — analysis ${uploaded.analysisStatus}` });
			} catch (e) {
				results.push({ processType: pt, ok: false, detail: e instanceof Error ? e.message : 'Upload failed' });
			}
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_robots',
			recordId: robotId,
			action: 'deck_calibration_sync',
			newData: { which, results },
			changedAt: new Date(),
			changedBy: locals.user?.username
		});

		return { success: true, action: 'sync', results };
	}
};
