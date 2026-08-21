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
	DeckFrame,
	AuditLog,
	generateId
} from '$lib/server/db';
import {
	applyDeckEditBatch,
	applyDeckEditsPerWell,
	deckEditHistory
} from '$lib/server/services/deck-calibration/apply-edit';
import { getRobot, robotUploadProtocol } from '$lib/server/opentrons/proxy';
// The single source of truth for "is this Z a height a pipette may be sent to".
// Shared with the probe path (resolveCalibratorPoint) so the studio cannot save a
// value the robot would then refuse to use — one window, one definition.
import {
	CAL_Z_LIMITS,
	plausibleZ,
	taughtXY,
	finite as finiteNum
} from '$lib/server/services/deck-calibration/tip-calibrator';
// The deck's own frame: four jogged corners → origin/size/rotation, and the
// u,v mapping that lets the calibrator be stored as a fraction of the deck
// instead of a bare absolute point that goes stale when the deck is reseated.
// In $lib/shared (not $lib/server) so the page can derive the same frame
// client-side for a live preview — one implementation, both sides.
import {
	CORNER_LABELS,
	MAX_RESIDUAL_MM,
	MAX_SILENT_REDERIVE_MM,
	deriveFrame,
	fromFrameRelative,
	toFrameRelative,
	validateCorners,
	withinFrame,
	type Corner,
	type DeckFrameDerived
} from '$lib/shared/deck-frame';
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

/**
 * The calibrator point baked into the .py before it was BIMS-tunable. Used when a
 * robot has no saved fixture yet, so the wizard always shows a real starting point
 * instead of 0,0,0 (which would drive the pipette into the corner of the deck).
 */
const CAL_DEFAULTS = { x: 125.181, y: 173.247, z: 34.491, zCalWax: 34.491, zCalReagent: 40.8 };
/** Keep the undo list short — operators only ever reach for the last few teaches. */
const CAL_HISTORY_MAX = 10;

/** One taught calibrator point, serialised for the client (dates → ISO strings). */
type CalHistoryEntry = {
	position: { x: number; y: number; z: number };
	zCalWax: number;
	zCalReagent: number;
	capturedBy: string | null;
	capturedAt: string | null;
	source: string;
	note: string | null;
};
type CalEntry = {
	robotId: string;
	position: { x: number; y: number; z: number };
	zCalWax: number;
	zCalReagent: number;
	capturedBy: string | null;
	capturedAt: string | null;
	history: CalHistoryEntry[];
	/** The taught deck hole this calibrator is anchored to, if one was captured. */
	referenceHole: {
		deckLoadName: string;
		wellName: string;
		nominal: { x: number; y: number; z: number };
		taught: { x: number; y: number; z: number };
		offset: { x: number; y: number; z: number } | null;
		capturedBy: string | null;
		capturedAt: string | null;
	} | null;
	/**
	 * True when this robot has no fixture row of its own and these numbers came
	 * from the shared 'global' row (loadCalibratorFixture's precedence: own row →
	 * 'global' → the .py default). It matters because the first Save forks the
	 * robot off 'global' permanently — from then on a change to the shared fixture
	 * stops reaching it — so the page has to be able to say so before the operator
	 * commits.
	 */
	inheritedFromGlobal: boolean;
};

/** Shape one raw history subdoc for the client, filling any gap with the defaults. */
function toCalHistoryEntry(h: any): CalHistoryEntry {
	return {
		position: {
			x: Number(h?.position?.x ?? CAL_DEFAULTS.x),
			y: Number(h?.position?.y ?? CAL_DEFAULTS.y),
			z: Number(h?.position?.z ?? CAL_DEFAULTS.z)
		},
		zCalWax: Number(h?.zCalWax ?? CAL_DEFAULTS.zCalWax),
		zCalReagent: Number(h?.zCalReagent ?? CAL_DEFAULTS.zCalReagent),
		capturedBy: h?.capturedBy?.username ?? null,
		capturedAt: h?.capturedAt?.toISOString?.() ?? null,
		source: h?.source ?? 'manual',
		note: h?.note ?? null
	};
}

/**
 * Turn the fixture doc we are about to overwrite into a history subdoc. Unlike
 * toCalHistoryEntry this stays in Mongo types (Date, operator object) because the
 * result is written straight back into history[]. `source`/`note` are supplied by
 * the caller and describe the write that is replacing this value.
 */
function toPrevSnapshot(prev: any) {
	return {
		position: {
			x: Number(prev?.position?.x ?? CAL_DEFAULTS.x),
			y: Number(prev?.position?.y ?? CAL_DEFAULTS.y),
			z: Number(prev?.position?.z ?? CAL_DEFAULTS.z)
		},
		zCalWax: Number(prev?.zCalWax ?? CAL_DEFAULTS.zCalWax),
		zCalReagent: Number(prev?.zCalReagent ?? CAL_DEFAULTS.zCalReagent),
		// Who captured the value being replaced, and when — not the person replacing it.
		capturedBy: prev?.capturedBy ?? null,
		capturedAt: prev?.capturedAt ?? null
	};
}

/**
 * Shape one raw TipCalibratorFixture doc for the client. Every read of a
 * calibrator (load + both actions) goes through here so the UI always gets the
 * same object, including for robots whose fixture predates the history array.
 *
 * `opts` exists because one doc can be surfaced under two identities: its own
 * row, and — for every robot that has no row — the shared 'global' fixture
 * standing in for that robot. In the second case the entry is keyed by the
 * borrowing robot, not by 'global', because the page looks calibrators up by
 * robotId.
 */
function toCalEntry(c: any, opts?: { robotId?: string; inheritedFromGlobal?: boolean }): CalEntry {
	const inheritedFromGlobal = opts?.inheritedFromGlobal === true;
	return {
		robotId: String(opts?.robotId ?? c?.robotId ?? ''),
		position: {
			x: Number(c?.position?.x ?? CAL_DEFAULTS.x),
			y: Number(c?.position?.y ?? CAL_DEFAULTS.y),
			z: Number(c?.position?.z ?? CAL_DEFAULTS.z)
		},
		zCalWax: Number(c?.zCalWax ?? CAL_DEFAULTS.zCalWax),
		zCalReagent: Number(c?.zCalReagent ?? CAL_DEFAULTS.zCalReagent),
		capturedBy: c?.capturedBy?.username ?? null,
		capturedAt: c?.capturedAt?.toISOString?.() ?? null,
		// An inherited entry deliberately carries NO history: the undo list drives
		// revertCalibrator, which only ever writes the robot's own row. Handing the
		// operator 'global' teaches as this robot's undo points would offer a revert
		// that either 404s or forks the robot off 'global' by accident.
		history: inheritedFromGlobal || !Array.isArray(c?.history) ? [] : c.history.map(toCalHistoryEntry),
		// Not carried across an inherited entry, for the same reason history is not:
		// the anchor belongs to the robot that taught it, and showing another
		// robot’s hole here would invite a re-derive against the wrong machine.
		referenceHole:
			inheritedFromGlobal || !c?.referenceHole
				? null
				: {
						deckLoadName: String(c.referenceHole.deckLoadName ?? ''),
						wellName: String(c.referenceHole.wellName ?? ''),
						nominal: vec3(c.referenceHole.nominal),
						taught: vec3(c.referenceHole.taught),
						offset: c.referenceHole.offset ? vec3(c.referenceHole.offset) : null,
						capturedBy: c.referenceHole.capturedBy?.username ?? null,
						capturedAt: c.referenceHole.capturedAt?.toISOString?.() ?? null
					},
		inheritedFromGlobal
	};
}

/** One taught deck frame, serialised for the client (dates → ISO strings). */
type FrameEntry = {
	robotId: string;
	deckLoadName: string | null;
	corners: { label: string; x: number; y: number; z: number }[];
	derived: DeckFrameDerived;
	capturedBy: string | null;
	capturedAt: string | null;
	historyCount: number;
};

/**
 * Shape one raw DeckFrame doc for the client.
 *
 * Deliberately NO defaults-filling of the kind toCalEntry does: a calibrator has
 * a sane .py fallback to stand in for a missing field, but half a deck frame is
 * not a deck frame. A robot either has four taught corners or it has none, so a
 * malformed row is surfaced as absent rather than patched into something that
 * looks taught.
 */
function toFrameEntry(f: any): FrameEntry | null {
	if (!f?.derived || !Array.isArray(f?.corners) || f.corners.length !== 4) return null;
	return {
		robotId: String(f.robotId ?? ''),
		deckLoadName: f.deckLoadName ?? null,
		corners: f.corners.map((c: any) => ({
			label: String(c?.label ?? ''),
			x: Number(c?.x),
			y: Number(c?.y),
			z: Number(c?.z)
		})),
		derived: {
			origin: { x: Number(f.derived.origin?.x), y: Number(f.derived.origin?.y) },
			uAxis: { x: Number(f.derived.uAxis?.x), y: Number(f.derived.uAxis?.y) },
			vAxis: { x: Number(f.derived.vAxis?.x), y: Number(f.derived.vAxis?.y) },
			width: Number(f.derived.width),
			height: Number(f.derived.height),
			rotationDeg: Number(f.derived.rotationDeg),
			squarenessDeg: Number(f.derived.squarenessDeg),
			residualMm: Number(f.derived.residualMm),
			surfaceZ: Number(f.derived.surfaceZ)
		},
		capturedBy: f.capturedBy?.username ?? null,
		capturedAt: f.capturedAt?.toISOString?.() ?? null,
		historyCount: Array.isArray(f.history) ? f.history.length : 0
	};
}

/**
 * Pull four corners out of submitted form data.
 *
 * Returns the corners unvalidated — validateCorners() owns every judgement about
 * whether they describe a deck, so there is exactly one place that decides. This
 * only turns strings into numbers, and does it with Number() so that a blank or
 * junk field arrives as NaN and is rejected by name downstream, rather than as
 * a 0 that reads as a real coordinate at the deck's front-left corner.
 */
function readCornersFromForm(data: FormData): Corner[] {
	return CORNER_LABELS.map((label) => ({
		label,
		x: Number(data.get(`corner_${label}_x`)),
		y: Number(data.get(`corner_${label}_y`)),
		z: Number(data.get(`corner_${label}_z`))
	}));
}

/** What a re-derive attempt did, or why it declined to do anything. */
type RederiveOutcome = {
	applied: boolean;
	/**
	 * Machine-readable so the page can tell "nothing to do" (silent) from
	 * "waiting on you" (a confirmation prompt) without matching on prose.
	 */
	reason: 'applied' | 'no-fixture' | 'no-relative' | 'underivable' | 'guard-failed' | 'needs-confirm';
	message: string;
	from?: { x: number; y: number };
	to?: { x: number; y: number };
	deltaMm?: number;
	/** How much the taught deck SURFACE moved in z, when we can tell. Never applied. */
	surfaceZDeltaMm?: number | null;
};

/**
 * Move a robot's calibrator onto a freshly-taught deck frame.
 *
 * Shared by saveDeckFrame (which calls it with force=false, so a large move is
 * reported rather than applied) and rederiveCalibrator (force=true, after the
 * operator has confirmed that move). Every decline is a first-class outcome with
 * a reason — this runs automatically on every frame save, and a robot that
 * simply has no calibrator linked yet must not read as a failure.
 *
 * ONLY x and y. See the note on saveDeckFrame for why z is reported, not derived.
 */
async function rederiveCalibratorForFrame(
	robotId: string,
	frame: DeckFrameDerived,
	user: { _id: string; username: string },
	force: boolean,
	prevSurfaceZ?: number | null
): Promise<RederiveOutcome> {
	const surfaceZDeltaMm =
		typeof prevSurfaceZ === 'number' && Number.isFinite(prevSurfaceZ)
			? frame.surfaceZ - prevSurfaceZ
			: null;

	// The robot's OWN row only. A robot running on the shared 'global' fixture has
	// nothing of its own to re-derive, and writing one here would fork it off
	// 'global' as a side effect of teaching corners — a consequential change the
	// page warns about before the operator makes it deliberately.
	const fixture = (await TipCalibratorFixture.findOne({ robotId }).lean()) as any;
	if (!fixture) {
		return {
			applied: false,
			reason: 'no-fixture',
			message: 'Deck frame saved. This robot has no calibrator of its own yet, so nothing was re-derived.',
			surfaceZDeltaMm
		};
	}

	const rel = fixture.frameRelative;
	if (rel == null || !Number.isFinite(Number(rel.u)) || !Number.isFinite(Number(rel.v))) {
		return {
			applied: false,
			reason: 'no-relative',
			message:
				'Deck frame saved. The calibrator is not linked to a frame yet — save it once with ' +
				'this frame taught, and future corner teaches will move it automatically.',
			surfaceZDeltaMm
		};
	}

	const next = fromFrameRelative(frame, { u: Number(rel.u), v: Number(rel.v) });
	if (!next) {
		return {
			applied: false,
			reason: 'underivable',
			message: 'Deck frame saved, but the calibrator position could not be derived from it.',
			surfaceZDeltaMm
		};
	}

	// The SAME guard the probe path applies (tip-calibrator.ts): a 0 is not a
	// taught coordinate. A degenerate frame that survived every earlier check
	// still must not be able to write one into production geometry.
	if (taughtXY(next.x) === undefined || taughtXY(next.y) === undefined) {
		return {
			applied: false,
			reason: 'guard-failed',
			message:
				'Deck frame saved, but the derived calibrator position failed the safety guard ' +
				`(x=${next.x}, y=${next.y}) and was not written.`,
			surfaceZDeltaMm
		};
	}

	const from = { x: Number(fixture.position?.x), y: Number(fixture.position?.y) };
	const deltaMm =
		Number.isFinite(from.x) && Number.isFinite(from.y)
			? Math.hypot(next.x - from.x, next.y - from.y)
			: Infinity;

	if (!force && deltaMm > MAX_SILENT_REDERIVE_MM) {
		return {
			applied: false,
			reason: 'needs-confirm',
			message:
				`Deck frame saved. Re-deriving would move the calibrator ${deltaMm.toFixed(2)} mm ` +
				`(limit ${MAX_SILENT_REDERIVE_MM} mm), so it was NOT changed. That much disagreement ` +
				`means the new corners and the old calibrator disagree about where the deck is — ` +
				`check the corners, then confirm if the move is real.`,
			from,
			to: next,
			deltaMm,
			surfaceZDeltaMm
		};
	}

	const now = new Date();
	await TipCalibratorFixture.updateOne(
		{ robotId },
		{
			// z is carried through untouched — the frame maps the deck plane only.
			$set: {
				'position.x': next.x,
				'position.y': next.y,
				'frameRelative.derivedAt': now,
				capturedBy: { _id: user._id, username: user.username },
				capturedAt: now
			},
			$push: {
				history: {
					$each: [{ ...toPrevSnapshot(fixture), source: 'frame', note: 'Re-derived from a new deck frame' }],
					$position: 0,
					$slice: CAL_HISTORY_MAX
				}
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'tip_calibrator_fixtures',
		recordId: robotId,
		action: 'rederive_calibrator',
		newData: { from, to: next, deltaMm, forced: force, frameRelative: { u: rel.u, v: rel.v } },
		changedAt: now,
		changedBy: user.username
	});

	return {
		applied: true,
		reason: 'applied',
		message: `Calibrator moved ${deltaMm.toFixed(2)} mm with the deck.`,
		from,
		to: next,
		deltaMm,
		surfaceZDeltaMm
	};
}

/** Plain {x,y,z} out of a Mongoose subdoc, with every axis a real number. */
function vec3(v: any): { x: number; y: number; z: number } {
	return { x: Number(v?.x ?? 0), y: Number(v?.y ?? 0), z: Number(v?.z ?? 0) };
}

/**
 * Move a robot’s calibrator onto a freshly-taught reference hole.
 *
 * The hole-anchored twin of rederiveCalibratorForFrame, and now the primary
 * path: re-teach the one hole after a deck is reseated and the calibrator
 * follows it, with no re-probe of the fixture.
 *
 * Fenced exactly like the frame re-derive, because it writes the same value the
 * PRODUCTION FILL PATH reads: the result must clear taughtXY, and a move beyond
 * MAX_SILENT_REDERIVE_MM is reported rather than applied. X AND Y ONLY — the
 * stored dz is recorded for reference but never applied, since the calibrator’s
 * z is an approach height above a fixture, not a depth below the deck plane.
 */
async function rederiveCalibratorFromHole(
	robotId: string,
	fixture: any,
	taught: { x: number; y: number; z: number },
	user: { _id: string; username: string },
	force: boolean
): Promise<RederiveOutcome> {
	const off = fixture?.referenceHole?.offset;
	if (!off || finiteNum(off.x) === undefined || finiteNum(off.y) === undefined) {
		return {
			applied: false,
			reason: 'no-relative',
			message:
				'Reference hole saved. The calibrator is not linked to it yet — teach the ' +
				'calibrator (sensor watch or probe) once and the link is made, after which ' +
				're-teaching this hole moves it automatically.'
		};
	}

	const next = { x: taught.x + Number(off.x), y: taught.y + Number(off.y) };
	if (taughtXY(next.x) === undefined || taughtXY(next.y) === undefined) {
		return {
			applied: false,
			reason: 'guard-failed',
			message:
				'Reference hole saved, but the derived calibrator position failed the ' +
				`safety guard (x=${next.x}, y=${next.y}) and was not written.`
		};
	}

	const from = { x: Number(fixture.position?.x), y: Number(fixture.position?.y) };
	const deltaMm =
		Number.isFinite(from.x) && Number.isFinite(from.y)
			? Math.hypot(next.x - from.x, next.y - from.y)
			: Infinity;

	if (!force && deltaMm > MAX_SILENT_REDERIVE_MM) {
		return {
			applied: false,
			reason: 'needs-confirm',
			message:
				`Reference hole saved. Re-deriving would move the calibrator ${deltaMm.toFixed(2)} mm ` +
				`(limit ${MAX_SILENT_REDERIVE_MM} mm), so it was NOT changed — the new hole position ` +
				`and the stored offset disagree by more than a reseat should account for. Check the ` +
				`hole, then confirm if the move is real.`,
			from,
			to: next,
			deltaMm
		};
	}

	const now = new Date();
	await TipCalibratorFixture.updateOne(
		{ robotId },
		{
			$set: {
				'position.x': next.x,
				'position.y': next.y,
				capturedBy: { _id: user._id, username: user.username },
				capturedAt: now
			},
			$push: {
				history: {
					$each: [
						{ ...toPrevSnapshot(fixture), source: 'frame', note: 'Re-derived from a re-taught reference hole' }
					],
					$position: 0,
					$slice: CAL_HISTORY_MAX
				}
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'tip_calibrator_fixtures',
		recordId: robotId,
		action: 'rederive_calibrator_from_hole',
		newData: { from, to: next, deltaMm, forced: force, wellName: fixture?.referenceHole?.wellName ?? null },
		changedAt: now,
		changedBy: user.username
	});

	return {
		applied: true,
		reason: 'applied',
		message: `Calibrator moved ${deltaMm.toFixed(2)} mm with the reference hole.`,
		from,
		to: next,
		deltaMm
	};
}

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
	// Includes the per-robot undo history (newest first) so the wizard can show the
	// previous value and offer one-click revert without a second round-trip.
	const calRows = (await TipCalibratorFixture.find({}).lean()) as any[];
	// A robot with no row of its own silently runs on the shared 'global' fixture
	// (loadCalibratorFixture's precedence). Looking calibrators up by robotId would
	// find nothing for those robots, so the page would show the .py defaults and
	// give no hint that the numbers actually in force belong to another document.
	// Synthesise one entry per such robot, keyed by that robot and flagged, so the
	// page can warn that the first Save forks it off 'global' for good. When there
	// is no 'global' row there is nothing to inherit — the robot really is on the
	// .py defaults, and the page's existing no-entry path already says so.
	const globalRow = calRows.find((c) => String(c?.robotId ?? '') === 'global') ?? null;
	const taughtRobotIds = new Set(calRows.map((c) => String(c?.robotId ?? '')));
	const calibrators = [
		...calRows.map((c) => toCalEntry(c)),
		...(globalRow
			? robots
					.filter((r) => !taughtRobotIds.has(r._id))
					.map((r) => toCalEntry(globalRow, { robotId: r._id, inheritedFromGlobal: true }))
			: [])
	];

	// Taught deck frames, one per robot that has one. Unlike calibrators there is
	// no 'global' stand-in: a frame measures where a plate sits on ONE machine, so
	// a robot without a row genuinely has no frame rather than inheriting a
	// fiction. Malformed rows drop out via toFrameEntry rather than half-loading.
	const deckFrames = ((await DeckFrame.find({}).lean()) as any[])
		.map(toFrameEntry)
		.filter((f): f is FrameEntry => f !== null);

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
		calibrators: JSON.parse(JSON.stringify(calibrators)),
		deckFrames: JSON.parse(JSON.stringify(deckFrames)),
		// Thresholds the UI has to render against (residual quality, re-derive
		// confirmation). Sent from here so the geometry module stays the single
		// source — a component cannot import from $lib/server.
		frameLimits: { maxResidualMm: MAX_RESIDUAL_MM, maxSilentRederiveMm: MAX_SILENT_REDERIVE_MM }
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
	 * PRD 2/3: save the tip-calibrator fixture (jog → probe → save) per robot.
	 *
	 * Step 4/5 of the teach wizard. Also persists the two probe Z heights, which
	 * the old version silently dropped, and snapshots the point being replaced
	 * onto history[] so step 5 can offer "revert to previous".
	 *
	 * Fields: robotId, x, y, z (required); zCalWax, zCalReagent (optional — the
	 * robot's current value is kept if omitted); source ('manual' | 'probe');
	 * note (optional free text, e.g. the probe adjustment that produced this).
	 *
	 * Every Z here ends up commanded on a real pipette — the probe reads the two
	 * zCal* fields and calibration-rtps injects them as production z_cal — so all
	 * three Z values are range-checked against CAL_Z_LIMITS before anything is
	 * written, and a failed check writes nothing at all.
	 */
	saveCalibrator: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim();
		const x = Number(data.get('x')), y = Number(data.get('y')), z = Number(data.get('z'));
		if (!robotId) return fail(400, { error: 'Pick a robot' });
		if (![x, y].every(Number.isFinite)) return fail(400, { error: 'x/y must be numbers' });
		// Save is the only write path into production z_cal, so this is the last
		// place a bad height can be caught by a human-readable message instead of by
		// the pipette hitting the fixture. Every rejection names its field, and we
		// reject rather than clamp (PRD §5.4) — a clamp would quietly send the tip
		// somewhere the operator never asked for.
		const zRange = `between ${CAL_Z_LIMITS.min} and ${CAL_Z_LIMITS.max} mm`;
		if (plausibleZ(z) === undefined) return fail(400, { error: `z (approach) must be a number ${zRange}` });

		// 'sensor' = taught from live limit-switch trips (the calibrator watch);
		// 'probe' = the closed-loop creep probe; anything else is a typed/jogged save.
		const rawSource = (data.get('source') as string)?.trim();
		const source =
			rawSource === 'probe' ? 'probe' : rawSource === 'sensor' ? 'sensor' : 'manual';
		const note = (data.get('note') as string)?.trim() || null;

		/**
		 * The limit-switch trips this point was taught from, if any.
		 *
		 * Parsed defensively and dropped on any problem rather than failing the
		 * save: these are a RECORD of how the point was measured, not the point
		 * itself, so losing them must never cost the operator a calibration they
		 * just spent a jog session producing. Capped for the same reason the
		 * switch-event endpoint caps its own array — a stuck switch.
		 */
		let switchEvents: unknown[] = [];
		const rawEvents = data.get('switchEvents');
		if (typeof rawEvents === 'string' && rawEvents.trim()) {
			try {
				const parsed = JSON.parse(rawEvents);
				if (Array.isArray(parsed)) switchEvents = parsed.slice(0, 100);
			} catch {
				switchEvents = [];
			}
		}

		// The doc we are about to overwrite — both the undo snapshot and the
		// fallback for any Z the caller did not send.
		const prev = (await TipCalibratorFixture.findOne({ robotId }).lean()) as any;

		// A blank/absent Z field means "leave it alone"; a present-but-junk one is an error.
		// The client only ever sends the key for the tip profile it is editing, so the
		// other one is always carried forward here — which is why this write has to
		// re-validate the carried value too, not just the submitted one.
		const rawWax = data.get('zCalWax');
		const rawReagent = data.get('zCalReagent');
		const hasWax = rawWax !== null && String(rawWax).trim() !== '';
		const hasReagent = rawReagent !== null && String(rawReagent).trim() !== '';

		let zCalWax: number;
		if (hasWax) {
			// Submitted by the operator: an implausible value is their mistake to fix,
			// so refuse the whole save rather than silently storing a different number.
			const v = plausibleZ(Number(rawWax));
			if (v === undefined) return fail(400, { error: `zCalWax (probe Z) must be a number ${zRange}` });
			zCalWax = v;
		} else {
			// Not submitted: carry the stored value forward. If what is stored is not a
			// usable height — most often a partial write that materialised as a real 0
			// (PRD §5.5) — fall back to the .py default instead of failing. The operator
			// is not editing this field, and blocking them on damage they did not cause
			// would make the bad value unfixable through the studio.
			zCalWax = plausibleZ(Number(prev?.zCalWax)) ?? CAL_DEFAULTS.zCalWax;
		}

		let zCalReagent: number;
		if (hasReagent) {
			const v = plausibleZ(Number(rawReagent));
			if (v === undefined) return fail(400, { error: `zCalReagent (probe Z) must be a number ${zRange}` });
			zCalReagent = v;
		} else {
			zCalReagent = plausibleZ(Number(prev?.zCalReagent)) ?? CAL_DEFAULTS.zCalReagent;
		}

		/**
		 * Link this point to the robot's deck frame, if it has one.
		 *
		 * DERIVED here rather than accepted from the client: the fraction must
		 * describe the position actually being stored, and the server is the only
		 * place that knows both the point that passed validation above and the
		 * frame currently on record. A client-supplied u,v could disagree with
		 * either, and the disagreement would only surface later as a re-derive
		 * that moves the calibrator somewhere nobody taught it.
		 *
		 * Absent frame, or a point that lands implausibly far outside it, simply
		 * means no link — `position` remains the absolute truth either way, so the
		 * save succeeds and the robot behaves exactly as it did before.
		 */
		let frameRelative: { u: number; v: number; frameId: string | null; derivedAt: Date } | null =
			null;
		const frameDoc = (await DeckFrame.findOne({ robotId }).lean()) as any;
		if (frameDoc?.derived) {
			const rel = toFrameRelative(frameDoc.derived, { x, y });
			if (rel && withinFrame(rel)) {
				frameRelative = {
					u: rel.u,
					v: rel.v,
					frameId: String(frameDoc._id),
					derivedAt: new Date()
				};
			}
		}

		/**
		 * Link this point to the robot's reference hole by storing the vector
		 * between them. THIS is what survives a reseat: re-teach the hole and the
		 * calibrator is re-derived as taught + offset.
		 *
		 * Derived server-side from the point that just passed validation and the
		 * hole currently on record, so the two can never disagree. dz is stored for
		 * reference only — the re-derive never applies it.
		 */
		const refHole = prev?.referenceHole;
		const holeOffset = refHole?.taught
			? {
					x: x - Number(refHole.taught.x),
					y: y - Number(refHole.taught.y),
					z: z - Number(refHole.taught.z)
				}
			: null;

		const capturedBy = { _id: locals.user._id, username: locals.user.username };
		const update: Record<string, any> = {
			$set: {
				position: { x, y, z },
				zCalWax,
				zCalReagent,
				capturedBy,
				capturedAt: new Date(),
				// Only overwrite the link when we have a new one. A save made while
				// the frame happens to be missing must not silently unlink a
				// calibrator that was correctly linked before.
				...(frameRelative ? { frameRelative } : {}),
				// Only when a hole is on record; never clears an existing link.
				...(holeOffset ? { 'referenceHole.offset': holeOffset } : {})
			},
			$setOnInsert: { _id: generateId() }
		};
		// Only push a snapshot if there was something to replace (a first teach has no history).
		if (prev) {
			update.$push = {
				history: {
					$each: [{ ...toPrevSnapshot(prev), source, note, switchEvents }],
					$position: 0, // newest first
					$slice: CAL_HISTORY_MAX
				}
			};
		}
		await TipCalibratorFixture.updateOne({ robotId }, update, { upsert: true });

		await AuditLog.create({ _id: generateId(), tableName: 'tip_calibrator_fixtures', recordId: robotId, action: 'save_calibrator', newData: { x, y, z, zCalWax, zCalReagent, source, note, frameRelative, switchEventCount: switchEvents.length }, changedAt: new Date(), changedBy: locals.user?.username });

		const saved = (await TipCalibratorFixture.findOne({ robotId }).lean()) as any;
		// inheritedFromGlobal is false by construction: the upsert just gave this
		// robot a row of its own, which is exactly the fork the page warned about.
		return { success: true, action: 'saveCalibrator', calibrator: JSON.parse(JSON.stringify(toCalEntry(saved))) };
	},

	/**
	 * PRD 2/3: put an earlier calibrator point back (the "undo my last teach"
	 * button). historyIndex is an index into the history array the page was
	 * loaded with — 0 is the most recently replaced point.
	 *
	 * The value being undone is itself pushed onto history (source 'revert'), so a
	 * mis-click is recoverable too; nothing is ever destroyed except by falling off
	 * the end of the 10-deep list.
	 */
	revertCalibrator: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim();
		const historyIndex = Number(data.get('historyIndex'));
		if (!robotId) return fail(400, { error: 'Pick a robot' });
		if (!Number.isInteger(historyIndex) || historyIndex < 0) {
			return fail(400, { error: 'historyIndex must be a whole number' });
		}

		const prev = (await TipCalibratorFixture.findOne({ robotId }).lean()) as any;
		if (!prev) return fail(404, { error: 'This robot has no saved calibrator to revert' });
		const entry = Array.isArray(prev.history) ? prev.history[historyIndex] : undefined;
		if (!entry) return fail(400, { error: 'That calibrator history entry no longer exists — reload the page' });

		const restored = toCalHistoryEntry(entry); // fills any gaps with the defaults
		const capturedBy = { _id: locals.user._id, username: locals.user.username };
		await TipCalibratorFixture.updateOne(
			{ robotId },
			{
				$set: {
					position: restored.position,
					zCalWax: restored.zCalWax,
					zCalReagent: restored.zCalReagent,
					capturedBy,
					capturedAt: new Date()
				},
				$push: {
					history: {
						$each: [{ ...toPrevSnapshot(prev), source: 'revert', note: `Replaced by revert to history #${historyIndex + 1}` }],
						$position: 0,
						$slice: CAL_HISTORY_MAX
					}
				}
			}
		);

		await AuditLog.create({ _id: generateId(), tableName: 'tip_calibrator_fixtures', recordId: robotId, action: 'revert_calibrator', newData: { historyIndex, ...restored.position, zCalWax: restored.zCalWax, zCalReagent: restored.zCalReagent }, changedAt: new Date(), changedBy: locals.user?.username });

		const saved = (await TipCalibratorFixture.findOne({ robotId }).lean()) as any;
		// Revert only ever runs against a robot's own row (it 404s above otherwise),
		// so this entry is never an inherited one.
		return { success: true, action: 'revertCalibrator', calibrator: JSON.parse(JSON.stringify(toCalEntry(saved))) };
	},

	/** PRD 5: save a robot's GLOBAL deck offset (applies to all labware at fill time). */
	/**
	 * Capture the deck hole the calibrator is anchored to.
	 *
	 * THE anchor for the calibrator, replacing the four-corner frame. A hole is a
	 * far better reference than a plate corner because it has a NOMINAL position
	 * in the deck definition, so the stored offset relates the fixture to the
	 * geometry the robot actually fills — and re-teaching it after a reseat is one
	 * jog rather than four.
	 *
	 * Re-teaching the SAME well keeps the offset and moves the calibrator with it.
	 * Choosing a DIFFERENT well clears the offset instead of re-pointing it: the
	 * old vector was measured from a different hole, and silently reusing it would
	 * fling the calibrator across the deck by the spacing between the two.
	 */
	saveReferenceHole: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim();
		const deckLoadName = (data.get('deckLoadName') as string)?.trim();
		const wellName = (data.get('wellName') as string)?.trim();
		if (!robotId) return fail(400, { error: 'Pick a robot' });
		if (!deckLoadName || !wellName) {
			return fail(400, { error: 'Move to a hole first — the reference needs a deck and a well' });
		}

		// Every axis explicitly. A blank field arriving as 0 would place the hole at
		// the deck corner and put the calibrator an entire deck away from itself.
		const read = (prefix: string) => {
			const out: Record<string, number> = {};
			for (const axis of ['x', 'y', 'z'] as const) {
				const v = finiteNum(data.get(`${prefix}${axis.toUpperCase()}`));
				if (v === undefined) return null;
				out[axis] = v;
			}
			return out as { x: number; y: number; z: number };
		};
		const nominal = read('nominal');
		const taught = read('taught');
		if (!nominal) return fail(400, { error: `No nominal x/y/z for ${wellName} — reselect the hole` });
		if (!taught) return fail(400, { error: 'No live position captured — jog to the hole, then capture' });

		const prev = (await TipCalibratorFixture.findOne({ robotId }).lean()) as any;
		const sameWell =
			prev?.referenceHole?.wellName === wellName &&
			prev?.referenceHole?.deckLoadName === deckLoadName;
		// Keep the offset only when it still means something (same hole).
		const offset = sameWell ? (prev?.referenceHole?.offset ?? null) : null;

		const capturedBy = { _id: locals.user._id, username: locals.user.username };
		const now = new Date();
		await TipCalibratorFixture.updateOne(
			{ robotId },
			{
				$set: {
					referenceHole: { deckLoadName, wellName, nominal, taught, offset, capturedBy, capturedAt: now }
				},
				// A robot with no fixture row yet still needs somewhere to put the anchor.
				// Seed the .py defaults rather than 0,0,0 — position is required, and a
				// zeroed one reads as "taught" to nothing that looks at it later.
				$setOnInsert: {
					_id: generateId(),
					position: { x: CAL_DEFAULTS.x, y: CAL_DEFAULTS.y, z: CAL_DEFAULTS.z },
					zCalWax: CAL_DEFAULTS.zCalWax,
					zCalReagent: CAL_DEFAULTS.zCalReagent
				}
			},
			{ upsert: true }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'tip_calibrator_fixtures',
			recordId: robotId,
			action: 'save_reference_hole',
			newData: { deckLoadName, wellName, nominal, taught, keptOffset: !!offset, sameWell },
			changedAt: now,
			changedBy: locals.user?.username
		});

		// Re-teaching the same hole is exactly the reseat case, so move the
		// calibrator with it. A fresh hole has no offset yet and simply reports that.
		const after = (await TipCalibratorFixture.findOne({ robotId }).lean()) as any;
		const rederive = await rederiveCalibratorFromHole(robotId, after, taught, locals.user, false);

		return {
			success: true,
			action: 'saveReferenceHole',
			calibrator: JSON.parse(JSON.stringify(toCalEntry(after))),
			rederive
		};
	},

	/**
	 * Apply a hole re-derive that saveReferenceHole refused to apply silently.
	 */
	rederiveFromHole: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim();
		if (!robotId) return fail(400, { error: 'Pick a robot' });

		const fixture = (await TipCalibratorFixture.findOne({ robotId }).lean()) as any;
		if (!fixture?.referenceHole?.taught) {
			return fail(400, { error: 'This robot has no taught reference hole to re-derive from' });
		}
		const rederive = await rederiveCalibratorFromHole(
			robotId,
			fixture,
			vec3(fixture.referenceHole.taught),
			locals.user,
			true
		);
		if (!rederive.applied) return fail(400, { error: rederive.message });
		return { success: true, action: 'rederiveFromHole', rederive };
	},
	/**
	 * Save the four jogged deck corners as this robot's deck frame, then re-derive
	 * the calibrator onto it.
	 *
	 * The re-derive is the reason the frame is worth teaching. Reseating a deck
	 * used to silently invalidate the calibrator's absolute point; with a frame,
	 * re-teaching four corners moves it with the deck and no fixture re-probe is
	 * needed.
	 *
	 * That same power is why this is the most dangerous write on the page: it
	 * changes a value the PRODUCTION FILL PATH reads (resolveCalibratorPoint), on
	 * the strength of four jogs. So the re-derive is fenced three ways —
	 *
	 *   1. the frame must fit (residual under MAX_RESIDUAL_MM) or nothing is saved;
	 *   2. the derived point must clear the same taughtXY guard the probe path uses,
	 *      so a degenerate frame cannot write a 0 that reads as taught;
	 *   3. a move beyond MAX_SILENT_REDERIVE_MM is REPORTED, not applied — over
	 *      that distance the new frame disagrees with the old one about where the
	 *      deck is, and a human decides. The frame still saves; only the
	 *      calibrator write waits for `rederiveCalibrator`.
	 *
	 * Z is deliberately NOT re-derived. The frame is a map of the deck PLANE; the
	 * calibrator's z is an approach height above the fixture, which u,v says
	 * nothing about. The corner heights do move around (surfaceZ), so the change
	 * is reported for the operator to act on — but inferring an approach height
	 * from four corner jogs would be a guess at the one axis where guessing wrong
	 * drives the pipette into the fixture.
	 */
	saveDeckFrame: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim();
		if (!robotId) return fail(400, { error: 'Pick a robot' });
		const deckLoadName = (data.get('deckLoadName') as string)?.trim() || null;
		const note = (data.get('note') as string)?.trim() || null;

		const corners = readCornersFromForm(data);
		const invalid = validateCorners(corners);
		if (invalid) return fail(400, { error: invalid });

		let derived: DeckFrameDerived;
		try {
			derived = deriveFrame(corners);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not derive a deck frame' });
		}

		// Reject rather than clamp, same as every other guard on this page. A frame
		// that does not fit is four points that are not one rectangle, and every
		// coordinate derived from it would be wrong with nothing to show for it.
		if (derived.residualMm > MAX_RESIDUAL_MM) {
			return fail(400, {
				error:
					`Those four corners do not describe one rectangle — the fit is off by ` +
					`${derived.residualMm.toFixed(2)} mm (limit ${MAX_RESIDUAL_MM} mm). Note the fit ` +
					`absorbs most of a single bad corner, so this means one corner is roughly ` +
					`${(derived.residualMm * 4).toFixed(1)} mm out of place. Re-jog the corners and try again.`
			});
		}

		const capturedBy = { _id: locals.user._id, username: locals.user.username };
		const now = new Date();
		const prevFrame = (await DeckFrame.findOne({ robotId }).lean()) as any;

		const stamped = corners.map((c) => ({ ...c, capturedAt: now, capturedBy }));
		const update: Record<string, any> = {
			$set: { deckLoadName, corners: stamped, derived, capturedBy, capturedAt: now },
			$setOnInsert: { _id: generateId() }
		};
		if (prevFrame) {
			update.$push = {
				history: {
					$each: [
						{
							corners: prevFrame.corners ?? [],
							derived: prevFrame.derived,
							capturedBy: prevFrame.capturedBy ?? null,
							capturedAt: prevFrame.capturedAt ?? null,
							note
						}
					],
					$position: 0,
					$slice: CAL_HISTORY_MAX
				}
			};
		}
		await DeckFrame.updateOne({ robotId }, update, { upsert: true });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'deck_frames',
			recordId: robotId,
			action: 'save_deck_frame',
			newData: { deckLoadName, corners: stamped, derived, note },
			changedAt: now,
			changedBy: locals.user?.username
		});

		const savedFrame = (await DeckFrame.findOne({ robotId }).lean()) as any;
		const rederive = await rederiveCalibratorForFrame(
			robotId,
			derived,
			locals.user,
			false,
			prevFrame?.derived?.surfaceZ ?? null
		);

		return {
			success: true,
			action: 'saveDeckFrame',
			frame: JSON.parse(JSON.stringify(toFrameEntry(savedFrame))),
			rederive
		};
	},

	/**
	 * Apply a re-derive that saveDeckFrame refused to apply silently.
	 *
	 * Reached only from the confirmation the page shows when the new frame would
	 * move the calibrator further than MAX_SILENT_REDERIVE_MM. Same write, same
	 * guards; the only difference is that a human has now looked at the distance.
	 */
	rederiveCalibrator: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const robotId = (data.get('robotId') as string)?.trim();
		if (!robotId) return fail(400, { error: 'Pick a robot' });

		const frameDoc = (await DeckFrame.findOne({ robotId }).lean()) as any;
		if (!frameDoc?.derived) {
			return fail(400, { error: 'This robot has no taught deck frame to re-derive from' });
		}

		const rederive = await rederiveCalibratorForFrame(robotId, frameDoc.derived, locals.user, true);
		if (!rederive.applied) {
			return fail(400, { error: rederive.message });
		}
		return { success: true, action: 'rederiveCalibrator', rederive };
	},

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

		// Global offsets are retired (2026-08-19). The deck definition is the only
		// source of hole positions, and the per-tip probe is the only correction on
		// top of it. A non-zero global offset moves all 576 holes plus the tube and
		// tip racks, so it silently double-counts geometry the Studio already tuned
		// — that is what caused the 07-08 deck-004 misses on B14 and pushed R04's
		// wax 1mm right on 08-19. Storing zero is still allowed so the row can stay
		// as an explicit "no offset" record.
		//
		// MERGE NOTE (2026-08-21): master carried this guard in saveCalibrator, where
		// x/y/z are the tip-calibrator FIXTURE POSITION (~125.181, 173.247, 34.491),
		// not an offset — so on master it rejected every legitimate calibrator save
		// while leaving this action, the one that actually writes RobotDeckOffset,
		// unguarded. Moved here, which is what it was written to protect.
		if (x !== 0 || y !== 0 || z !== 0) {
			return fail(400, {
				error:
					`Global robot offsets are retired — this would move every hole on the deck, ` +
					`not just the one you measured. The deck definition is the single source of ` +
					`truth for hole positions; correct the hole in the Studio instead, and let the ` +
					`per-tip calibrator handle tip-to-tip variation.`
			});
		}

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
