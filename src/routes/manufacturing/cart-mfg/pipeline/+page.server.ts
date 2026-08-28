/**
 * Manufacturing Pipeline — single page that shows entities at one of six
 * pipeline stages, switchable via a `?stage=` query param. Pipeline-flow
 * tiles on /manufacturing/cart-mfg-dev deep-link here so an operator can
 * click any tile and immediately see what's behind that count.
 *
 * Stage data shapes are normalised into one row format so the same table
 * UI can render any stage. Stage-specific extras are surfaced via the
 * `extra` map on each row.
 */
import { redirect } from '@sveltejs/kit';
import { isCureComplete, cureRemainingMin } from '$lib/server/manufacturing/cure-time';
import {
	connectDB, BackingLot, WaxFillingRun, ReagentBatchRecord, CartridgeRecord,
	Equipment, ManufacturingSettings
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { getCheckedOutCartridgeIds } from '$lib/server/checkout-utils';
import { ANY_TERMINAL } from '$lib/server/manufacturing/run-statuses';
import { WAX_STAGE_STATUSES } from '$lib/shared/cartridge-wax-status';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

const STAGE_KEYS = ['backing', 'wax_fill', 'cooling', 'reagent', 'seal', 'store'] as const;
type StageKey = (typeof STAGE_KEYS)[number];

export interface PipelineRow {
	id: string;             // primary identifier (lot id, run id, fridge name)
	idLabel?: string;       // display label override (e.g. shortened id)
	status: string;         // human-readable status
	count: number;          // cartridge count in this row
	location: string | null;
	operator: string | null;
	when: string | null;    // ISO timestamp
	elapsedMin: number | null; // minutes since `when`
	extras: Record<string, string | number | null>; // stage-specific fields
	detailHref: string | null; // link to drill into this row, if any
}

interface StageMeta {
	key: StageKey;
	label: string;
	description: string;
	color: string;
	headers: { key: string; label: string }[];
}

const STAGE_META: Record<StageKey, StageMeta> = {
	backing: {
		key: 'backing', label: 'Backing', color: 'tron-purple',
		description: 'Cartridges currently backing in ovens. Each cartridge is scanned in individually at WI-01 and exists as its own record; rows group them per WI-01 batch. Legacy backing-lot buckets are shown read-only until drained.',
		headers: [
			{ key: 'id', label: 'Lot' },
			{ key: 'status', label: 'Status' },
			{ key: 'count', label: 'Cartridges' },
			{ key: 'location', label: 'Oven' },
			{ key: 'operator', label: 'Operator' },
			{ key: 'when', label: 'Entered' },
			{ key: 'elapsed', label: 'Elapsed' },
			{ key: 'ready', label: 'Ready?' }
		]
	},
	wax_fill: {
		key: 'wax_fill', label: 'Wax Fill', color: 'tron-yellow',
		description: 'Active wax-filling runs. Each row is one OT-2 run currently in progress.',
		headers: [
			{ key: 'id', label: 'Run' },
			{ key: 'status', label: 'Stage' },
			{ key: 'count', label: 'Cartridges' },
			{ key: 'location', label: 'Robot' },
			{ key: 'operator', label: 'Operator' },
			{ key: 'when', label: 'Started' },
			{ key: 'elapsed', label: 'Elapsed' }
		]
	},
	cooling: {
		key: 'cooling', label: 'Cooling', color: 'tron-blue',
		description: 'Wax-stored cartridges currently cooling in a fridge, grouped by storage location.',
		headers: [
			{ key: 'id', label: 'Fridge' },
			{ key: 'status', label: 'Status' },
			{ key: 'count', label: 'Cartridges' },
			{ key: 'when', label: 'Oldest' },
			{ key: 'elapsed', label: 'Oldest age' }
		]
	},
	reagent: {
		key: 'reagent', label: 'Reagent', color: 'tron-orange',
		description: 'Active reagent-filling runs.',
		headers: [
			{ key: 'id', label: 'Run' },
			{ key: 'status', label: 'Stage' },
			{ key: 'count', label: 'Cartridges' },
			{ key: 'location', label: 'Robot' },
			{ key: 'operator', label: 'Operator' },
			{ key: 'when', label: 'Started' },
			{ key: 'elapsed', label: 'Elapsed' }
		]
	},
	seal: {
		key: 'seal', label: 'Seal', color: 'tron-cyan',
		description: 'Cartridges sealed but not yet stored, grouped by top-seal batch.',
		headers: [
			{ key: 'id', label: 'Batch' },
			{ key: 'status', label: 'Status' },
			{ key: 'count', label: 'Cartridges' },
			{ key: 'operator', label: 'Operator' },
			{ key: 'when', label: 'Sealed' },
			{ key: 'elapsed', label: 'Age' }
		]
	},
	store: {
		key: 'store', label: 'Store', color: 'tron-green',
		description: 'Cartridges in long-term storage, grouped by fridge.',
		headers: [
			{ key: 'id', label: 'Fridge' },
			{ key: 'status', label: 'Status' },
			{ key: 'count', label: 'Cartridges' },
			{ key: 'when', label: 'Oldest' },
			{ key: 'elapsed', label: 'Oldest age' }
		]
	}
};

function ageMin(ts: Date | string | null | undefined, now: Date): number | null {
	if (!ts) return null;
	const t = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
	if (Number.isNaN(t)) return null;
	return Math.max(0, Math.floor((now.getTime() - t) / 60000));
}

function shortId(id: string, n = 8): string {
	if (!id) return '';
	return id.length <= n + 3 ? id : `${id.slice(0, n)}…`;
}

async function loadBacking(now: Date, checkedOutIds: string[]): Promise<PipelineRow[]> {
	// WAX-FLOW-2: cartridges at the backing stage are individual CartridgeRecords
	// (status='backing'), scanned in one-by-one at WI-01. One row per WI-01 batch.
	// Legacy BackingLot aggregate buckets (no per-cartridge records) are appended
	// read-only until drained — nothing writes to BackingLot any more.
	const [groups, legacyLots, settings] = await Promise.all([
		CartridgeRecord.aggregate([
			{ $match: { status: 'backing', _id: { $nin: checkedOutIds } } },
			{ $group: {
				_id: '$backing.parentLotRecordId',
				count: { $sum: 1 },
				oldestEntry: { $min: '$backing.ovenEntryTime' },
				ovenNames: { $addToSet: '$backing.ovenLocationName' },
				operator: { $last: '$backing.operator.username' }
			} },
			{ $sort: { oldestEntry: -1 } }
		]) as any as Promise<any[]>,
		BackingLot.find({
			status: { $in: ['in_oven', 'ready', 'created'] },
			cartridgeCount: { $gt: 0 }
		}).sort({ ovenEntryTime: -1 }).lean() as any as Promise<any[]>,
		ManufacturingSettings.findById('default').select('waxFilling.minOvenTimeMin').lean() as any as Promise<any>
	]);
	const minOvenMin: number = settings?.waxFilling?.minOvenTimeMin ?? 30;

	const batchRows: PipelineRow[] = groups.map((g: any) => {
		const lotId = String(g._id ?? 'unknown');
		const elapsed = ageMin(g.oldestEntry, now);
		const ready = isCureComplete(g.oldestEntry, minOvenMin, now.getTime());
		return {
			id: lotId,
			idLabel: shortId(lotId, 12),
			status: ready ? 'ready' : 'in_oven',
			count: g.count ?? 0,
			location: (g.ovenNames ?? []).filter(Boolean).join(', ') || null,
			operator: g.operator ?? null,
			when: g.oldestEntry ? new Date(g.oldestEntry).toISOString() : null,
			elapsedMin: elapsed,
			extras: {
				ready: ready ? 'yes' : 'no',
				minOvenMin,
				remainingMin: ready || elapsed == null ? 0 : Math.max(0, minOvenMin - elapsed)
			},
			detailHref: `/manufacturing/cart-mfg/lots/${encodeURIComponent(lotId)}`
		};
	});

	const legacyRows: PipelineRow[] = legacyLots.map((l: any) => {
		const elapsed = ageMin(l.ovenEntryTime, now);
		const ready = elapsed != null && elapsed >= minOvenMin;
		return {
			id: String(l._id),
			idLabel: `${shortId(String(l._id), 12)} (legacy bucket)`,
			status: l.status ?? 'unknown',
			count: l.cartridgeCount ?? 0,
			location: l.ovenLocationName ?? l.ovenLocationId ?? null,
			operator: l.operator?.username ?? null,
			when: l.ovenEntryTime ? new Date(l.ovenEntryTime).toISOString() : null,
			elapsedMin: elapsed,
			extras: {
				ready: ready ? 'yes' : (l.status === 'consumed' ? '—' : 'no'),
				minOvenMin,
				remainingMin: ready || elapsed == null ? 0 : Math.max(0, minOvenMin - elapsed),
				legacy: 'legacy bucket'
			},
			detailHref: null
		};
	});

	return [...batchRows, ...legacyRows];
}

async function loadWaxFill(now: Date): Promise<PipelineRow[]> {
	const runs = await WaxFillingRun.find({
		// Excludes every terminal value (both casings) from
		// $lib/server/manufacturing/run-statuses — wax runs lean lowercase,
		// reagent runs lean capitalized.
		status: { $nin: ANY_TERMINAL }
	}).sort({ runStartTime: -1 }).lean() as any[];

	return runs.map((r: any) => ({
		id: String(r._id),
		idLabel: shortId(String(r._id), 8),
		status: r.status ?? 'unknown',
		count: r.cartridgeIds?.length ?? r.plannedCartridgeCount ?? 0,
		location: r.robot?.name ?? null,
		operator: r.operator?.username ?? null,
		when: r.runStartTime ? new Date(r.runStartTime).toISOString() : null,
		elapsedMin: ageMin(r.runStartTime, now),
		extras: { plannedCount: r.plannedCartridgeCount ?? null },
		detailHref: `/cartridge-admin?runId=${encodeURIComponent(String(r._id))}`
	}));
}

async function loadCooling(now: Date, checkedOutIds: string[]): Promise<PipelineRow[]> {
	// Group wax-stage cartridges sitting in a fridge by waxStorage.location
	// (denormalised name). WAX-SIMPLIFY-1: wax_filled IS the stored state.
	const agg = await CartridgeRecord.aggregate([
		{ $match: {
			status: { $in: [...WAX_STAGE_STATUSES] },
			'waxStorage.location': { $exists: true, $ne: null },
			_id: { $nin: checkedOutIds }
		}},
		{ $group: {
			_id: '$waxStorage.location',
			count: { $sum: 1 },
			oldest: { $min: '$waxStorage.timestamp' },
			newest: { $max: '$waxStorage.timestamp' }
		}},
		{ $sort: { count: -1 } }
	]);

	// Resolve fridge equipment ids so the row can deep-link to /equipment/location/[id]
	const equipmentByName = new Map<string, any>();
	const fridges = await Equipment.find({ equipmentType: 'fridge' }).select('_id name barcode').lean() as any[];
	for (const eq of fridges) {
		if (eq.name) equipmentByName.set(eq.name, eq);
		if (eq.barcode) equipmentByName.set(eq.barcode, eq);
	}

	return agg.map((row: any) => {
		const eq = equipmentByName.get(row._id);
		return {
			id: String(row._id),
			status: 'cooling',
			count: row.count,
			location: String(row._id),
			operator: null,
			when: row.oldest ? new Date(row.oldest).toISOString() : null,
			elapsedMin: ageMin(row.oldest, now),
			extras: {
				newest: row.newest ? new Date(row.newest).toISOString() : null
			},
			detailHref: eq ? `/equipment/location/${encodeURIComponent(String(eq._id))}` : null
		};
	});
}

async function loadReagent(now: Date): Promise<PipelineRow[]> {
	const runs = await ReagentBatchRecord.find({
		// Excludes every terminal value (both casings) from
		// $lib/server/manufacturing/run-statuses — wax runs lean lowercase,
		// reagent runs lean capitalized.
		status: { $nin: ANY_TERMINAL }
	}).sort({ runStartTime: -1 }).lean() as any[];

	return runs.map((r: any) => ({
		id: String(r._id),
		idLabel: shortId(String(r._id), 8),
		status: r.status ?? 'unknown',
		count: r.cartridgeCount ?? r.cartridgesFilled?.length ?? 0,
		location: r.robot?.name ?? null,
		operator: r.operator?.username ?? null,
		when: r.runStartTime ? new Date(r.runStartTime).toISOString() : null,
		elapsedMin: ageMin(r.runStartTime, now),
		extras: { assayName: r.assayType?.name ?? null },
		detailHref: `/cartridge-admin?runId=${encodeURIComponent(String(r._id))}`
	}));
}

async function loadSeal(now: Date, checkedOutIds: string[]): Promise<PipelineRow[]> {
	// Group cartridges currently at the seal stage (status='sealed' or 'cured')
	// by their top_seal.batchId so each row is one sealing batch.
	const agg = await CartridgeRecord.aggregate([
		{ $match: {
			status: { $in: ['sealed', 'cured'] },
			'topSeal.batchId': { $exists: true, $ne: null },
			_id: { $nin: checkedOutIds }
		}},
		{ $group: {
			_id: '$topSeal.batchId',
			count: { $sum: 1 },
			oldest: { $min: '$topSeal.timestamp' },
			newest: { $max: '$topSeal.timestamp' },
			operator: { $last: '$topSeal.operator.username' },
			topSealLotId: { $last: '$topSeal.topSealLotId' }
		}},
		{ $sort: { newest: -1 } }
	]);

	return agg.map((row: any) => ({
		id: String(row._id),
		idLabel: shortId(String(row._id), 10),
		status: 'sealed',
		count: row.count,
		location: null,
		operator: row.operator ?? null,
		when: row.newest ? new Date(row.newest).toISOString() : null,
		elapsedMin: ageMin(row.newest, now),
		extras: {
			topSealLotId: row.topSealLotId ?? null,
			oldest: row.oldest ? new Date(row.oldest).toISOString() : null
		},
		detailHref: null
	}));
}

async function loadStore(now: Date, checkedOutIds: string[]): Promise<PipelineRow[]> {
	const agg = await CartridgeRecord.aggregate([
		{ $match: {
			status: 'stored',
			'storage.fridgeName': { $exists: true, $ne: null },
			_id: { $nin: checkedOutIds }
		}},
		{ $group: {
			_id: '$storage.fridgeName',
			count: { $sum: 1 },
			oldest: { $min: '$storage.timestamp' },
			newest: { $max: '$storage.timestamp' }
		}},
		{ $sort: { count: -1 } }
	]);

	const equipmentByName = new Map<string, any>();
	const fridges = await Equipment.find({ equipmentType: 'fridge' }).select('_id name barcode').lean() as any[];
	for (const eq of fridges) {
		if (eq.name) equipmentByName.set(eq.name, eq);
		if (eq.barcode) equipmentByName.set(eq.barcode, eq);
	}

	return agg.map((row: any) => {
		const eq = equipmentByName.get(row._id);
		return {
			id: String(row._id),
			status: 'stored',
			count: row.count,
			location: String(row._id),
			operator: null,
			when: row.oldest ? new Date(row.oldest).toISOString() : null,
			elapsedMin: ageMin(row.oldest, now),
			extras: { newest: row.newest ? new Date(row.newest).toISOString() : null },
			detailHref: eq ? `/equipment/location/${encodeURIComponent(String(eq._id))}` : null
		};
	});
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const requested = (url.searchParams.get('stage') ?? 'backing').toLowerCase();
	const stage: StageKey = (STAGE_KEYS as readonly string[]).includes(requested)
		? (requested as StageKey)
		: 'backing';

	const now = new Date();
	let rows: PipelineRow[] = [];

	if (stage === 'backing') {
		const checkedOutIds = await getCheckedOutCartridgeIds();
		rows = await loadBacking(now, checkedOutIds);
	} else if (stage === 'wax_fill') {
		rows = await loadWaxFill(now);
	} else if (stage === 'cooling') {
		const checkedOutIds = await getCheckedOutCartridgeIds();
		rows = await loadCooling(now, checkedOutIds);
	} else if (stage === 'reagent') {
		rows = await loadReagent(now);
	} else if (stage === 'seal') {
		const checkedOutIds = await getCheckedOutCartridgeIds();
		rows = await loadSeal(now, checkedOutIds);
	} else if (stage === 'store') {
		const checkedOutIds = await getCheckedOutCartridgeIds();
		rows = await loadStore(now, checkedOutIds);
	}

	const totalCount = rows.reduce((s, r) => s + r.count, 0);
	const meta = STAGE_META[stage];

	return {
		stage,
		meta: {
			label: meta.label,
			color: meta.color,
			description: meta.description,
			headers: meta.headers
		},
		stages: STAGE_KEYS.map((k) => ({
			key: k,
			label: STAGE_META[k].label,
			color: STAGE_META[k].color
		})),
		rows: JSON.parse(JSON.stringify(rows)),
		totalRows: rows.length,
		totalCount
	};
};
