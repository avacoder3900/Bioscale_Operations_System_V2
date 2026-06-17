/**
 * BIMS integrity scan — the seven known data-quality checks, run on a schedule
 * (see /api/cron/bims-anomaly-scan) and read on-demand by the Ask BIMS
 * `check_data_integrity` tool.
 *
 * Two entry points:
 *   - `scanAndPersist()` — runs every check, upserts into the `bims_anomalies`
 *     collection (one row per (kind, targetType, targetId)), and returns a
 *     summary keyed by check kind. Called by the cron.
 *   - `summarizeFromAnomalies()` — reads the persisted anomalies and shapes
 *     them into the same summary the tool used to return. Called by the tool.
 *   - `computeSummary()` — recompute path (no persistence). Used as fallback
 *     when the anomaly collection is empty on first run.
 *
 * Each check's logic lives in a small helper so a refactor or a new check can
 * be added without rewriting the orchestrator.
 */
import {
	WaxFillingRun, ReceivingLot, Equipment, CartridgeRecord,
	ReagentBatchRecord, PartDefinition, BimsAnomaly,
	generateId
} from './db';

const FOUR_HOURS_MS = 4 * 3600e3;
const SEVEN_DAYS_MS = 7 * 86400e3;
const THIRTY_DAYS_MS = 30 * 86400e3;
const WAX_TUBE_PART_NUMBER = 'PT-CT-114';
const FULL_TUBE_VOLUME_UL = 12000;

// Cartridge statuses that mean "this cartridge is done moving" — anything
// outside this set is considered in-flight for the stuck-cartridge check.
const TERMINAL_CARTRIDGE_STATUSES = [
	'completed', 'cancelled', 'scrapped', 'voided', 'released', 'shipped', 'archived'
];

// v1 status names that should have been migrated. If any of these still exist
// in cartridge_records the migration is incomplete (Memory: project_currentphase_status_migration_incomplete).
const LEGACY_CARTRIDGE_STATUSES = ['packeted', 'transferred', 'refrigerated', 'received'];

export type AnomalyKind =
	| 'null_wax_source_lot'
	| 'over_consumed_receiving_lot'
	| 'stale_temperature_read'
	| 'stuck_cartridge'
	| 'orphan_lot_reference'
	| 'denormalized_counter_drift'
	| 'legacy_status_carrier';

export interface AnomalyFinding {
	kind: AnomalyKind;
	targetType: string;
	targetId: string;
	severity: 'info' | 'warning' | 'error';
	details: Record<string, unknown>;
}

export interface ScanResultByKind {
	count: number;
	sample: Array<Record<string, unknown>>; // up to 5 representative items per kind
}

export interface IntegritySummary {
	totalIssueCount: number;
	issues: string[];
	byKind: Record<AnomalyKind | 'overConsumedLots' | 'staleEquipmentReads' | 'stuckCartridges' | 'nullWaxSourceLot' | 'orphanLotReferences' | 'counterDrift' | 'legacyStatusCarriers', ScanResultByKind>;
}

// === Per-check finders ====================================================

async function findNullWaxSource(): Promise<AnomalyFinding[]> {
	const since = new Date(Date.now() - THIRTY_DAYS_MS);
	const runs = await WaxFillingRun.find({
		status: 'completed',
		runEndTime: { $gte: since },
		$or: [
			{ waxSourceLot: { $exists: false } },
			{ waxSourceLot: null },
			{ waxSourceLot: '' }
		]
	}).select('_id runStartTime runEndTime operator').lean() as any[];

	return runs.map(r => ({
		kind: 'null_wax_source_lot' as const,
		targetType: 'WaxFillingRun',
		targetId: r._id,
		severity: 'warning' as const,
		details: {
			runStartTime: r.runStartTime,
			runEndTime: r.runEndTime,
			operator: r.operator?.username
		}
	}));
}

async function findOverConsumedLots(): Promise<AnomalyFinding[]> {
	const lots = await ReceivingLot.find({
		'part.partNumber': WAX_TUBE_PART_NUMBER,
		$expr: { $gt: ['$consumedUl', { $multiply: ['$quantity', FULL_TUBE_VOLUME_UL] }] }
	}).select('_id lotId quantity consumedUl part').lean() as any[];

	return lots.map(l => ({
		kind: 'over_consumed_receiving_lot' as const,
		targetType: 'ReceivingLot',
		targetId: l._id,
		severity: 'error' as const,
		details: {
			lotId: l.lotId,
			partNumber: l.part?.partNumber,
			quantity: l.quantity,
			capacityUl: (l.quantity ?? 0) * FULL_TUBE_VOLUME_UL,
			consumedUl: l.consumedUl
		}
	}));
}

async function findStaleEquipmentReads(): Promise<AnomalyFinding[]> {
	const cutoff = new Date(Date.now() - FOUR_HOURS_MS);
	const eqs = await Equipment.find({
		equipmentType: { $in: ['fridge', 'oven'] },
		$or: [
			{ lastTemperatureReadAt: { $lt: cutoff } },
			{ lastTemperatureReadAt: { $exists: false } }
		]
	}).select('_id name lastTemperatureReadAt equipmentType').lean() as any[];

	return eqs.map(e => ({
		kind: 'stale_temperature_read' as const,
		targetType: 'Equipment',
		targetId: e._id,
		severity: 'warning' as const,
		details: {
			name: e.name,
			equipmentType: e.equipmentType,
			lastTemperatureReadAt: e.lastTemperatureReadAt ?? null
		}
	}));
}

async function findStuckCartridges(): Promise<AnomalyFinding[]> {
	const cutoff = new Date(Date.now() - SEVEN_DAYS_MS);
	const carts = await CartridgeRecord.find({
		status: { $nin: TERMINAL_CARTRIDGE_STATUSES },
		updatedAt: { $lt: cutoff }
	}).select('_id status createdAt updatedAt').lean() as any[];

	return carts.map(c => ({
		kind: 'stuck_cartridge' as const,
		targetType: 'CartridgeRecord',
		targetId: c._id,
		severity: 'warning' as const,
		details: {
			status: c.status,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt
		}
	}));
}

async function findOrphanReagentBatchRefs(): Promise<AnomalyFinding[]> {
	// Look at the last 90 days of batch records to keep the scan bounded.
	const since = new Date(Date.now() - 90 * 86400e3);
	const batches = await ReagentBatchRecord.find({
		createdAt: { $gte: since }
	}).select('_id tubeRecords createdAt').lean() as any[];

	const sourceLotIds = new Set<string>();
	for (const b of batches) {
		for (const t of b.tubeRecords ?? []) {
			if (t?.sourceLotId) sourceLotIds.add(t.sourceLotId);
		}
	}
	if (sourceLotIds.size === 0) return [];

	const resolved = await ReceivingLot.find({
		_id: { $in: Array.from(sourceLotIds) }
	}).select('_id').lean() as any[];
	const resolvedIds = new Set(resolved.map(r => r._id));

	const findings: AnomalyFinding[] = [];
	for (const b of batches) {
		for (const t of b.tubeRecords ?? []) {
			if (t?.sourceLotId && !resolvedIds.has(t.sourceLotId)) {
				findings.push({
					kind: 'orphan_lot_reference',
					targetType: 'ReagentBatchRecord',
					targetId: b._id,
					severity: 'warning',
					details: {
						orphanSourceLotId: t.sourceLotId,
						batchCreatedAt: b.createdAt
					}
				});
			}
		}
	}
	return findings;
}

async function findCounterDrift(): Promise<AnomalyFinding[]> {
	// Compare PartDefinition.inventoryCount to sum-of-accepted-lots.
	// 5% tolerance band — small drift is normal; flag only meaningful gaps.
	const parts = await PartDefinition.find({
		inventoryCount: { $gt: 0 }
	}).select('_id partNumber name inventoryCount').lean() as any[];
	if (parts.length === 0) return [];

	const partNumbers = parts.map(p => p.partNumber).filter(Boolean);
	const lotSums = await ReceivingLot.aggregate([
		{ $match: { 'part.partNumber': { $in: partNumbers }, status: 'accepted' } },
		{ $group: { _id: '$part.partNumber', total: { $sum: '$quantity' } } }
	]) as any[];
	const sumByPart = new Map(lotSums.map(s => [s._id, s.total]));

	const findings: AnomalyFinding[] = [];
	for (const p of parts) {
		const expected = sumByPart.get(p.partNumber) ?? 0;
		if (expected === 0) continue; // nothing to compare against — skip
		const drift = Math.abs((p.inventoryCount ?? 0) - expected);
		const pct = drift / expected;
		if (pct > 0.05) {
			findings.push({
				kind: 'denormalized_counter_drift',
				targetType: 'PartDefinition',
				targetId: p._id,
				severity: 'warning',
				details: {
					partNumber: p.partNumber,
					name: p.name,
					counterValue: p.inventoryCount,
					lotSumQuantity: expected,
					driftPct: Math.round(pct * 1000) / 10
				}
			});
		}
	}
	return findings;
}

async function findLegacyStatusCarriers(): Promise<AnomalyFinding[]> {
	const carts = await CartridgeRecord.find({
		status: { $in: LEGACY_CARTRIDGE_STATUSES }
	}).select('_id status updatedAt').lean() as any[];

	return carts.map(c => ({
		kind: 'legacy_status_carrier' as const,
		targetType: 'CartridgeRecord',
		targetId: c._id,
		severity: 'info' as const,
		details: { legacyStatus: c.status, updatedAt: c.updatedAt }
	}));
}

// === Orchestrators ========================================================

/**
 * Run every check and return the raw findings. Doesn't persist anything.
 * Used by the recompute fallback path.
 */
export async function runAllChecks(): Promise<AnomalyFinding[]> {
	const [
		nullWax, overConsumed, staleTemp, stuckCarts, orphans, drift, legacy
	] = await Promise.all([
		findNullWaxSource(),
		findOverConsumedLots(),
		findStaleEquipmentReads(),
		findStuckCartridges(),
		findOrphanReagentBatchRefs(),
		findCounterDrift(),
		findLegacyStatusCarriers()
	]);
	return [...nullWax, ...overConsumed, ...staleTemp, ...stuckCarts, ...orphans, ...drift, ...legacy];
}

/**
 * Roll a list of findings into the summary shape the Ask BIMS tool returns
 * (and that the cron logs).
 */
export function summarizeFindings(findings: AnomalyFinding[]): IntegritySummary {
	const byKind: Record<string, ScanResultByKind> = {};
	const groups: Record<string, AnomalyFinding[]> = {};
	for (const f of findings) {
		(groups[f.kind] ??= []).push(f);
	}

	const issues: string[] = [];
	for (const [kind, items] of Object.entries(groups)) {
		byKind[kind] = {
			count: items.length,
			sample: items.slice(0, 5).map(it => ({
				targetType: it.targetType,
				targetId: it.targetId,
				...it.details
			}))
		};
	}

	// Stable English bullets in the same order the tool emitted them before.
	const nullWaxCount = byKind['null_wax_source_lot']?.count ?? 0;
	const staleTempCount = byKind['stale_temperature_read']?.count ?? 0;
	const stuckCount = byKind['stuck_cartridge']?.count ?? 0;
	const overConsumedCount = byKind['over_consumed_receiving_lot']?.count ?? 0;
	const orphanCount = byKind['orphan_lot_reference']?.count ?? 0;
	const driftCount = byKind['denormalized_counter_drift']?.count ?? 0;
	const legacyCount = byKind['legacy_status_carrier']?.count ?? 0;

	if (nullWaxCount > 0) issues.push(`${nullWaxCount} completed wax run(s) have null waxSourceLot.`);
	if (staleTempCount > 0) issues.push(`${staleTempCount} equipment record(s) have lastTemperatureReadAt > 4h old or missing.`);
	if (stuckCount > 0) issues.push(`${stuckCount} cartridge(s) have been in non-terminal status > 7 days.`);
	if (overConsumedCount > 0) issues.push(`${overConsumedCount} wax-tube lot(s) report consumedUl exceeding capacity (data corruption).`);
	if (orphanCount > 0) issues.push(`${orphanCount} reagent batch tube(s) reference receiving lot IDs that don't resolve.`);
	if (driftCount > 0) issues.push(`${driftCount} part(s) show >5% drift between inventoryCount and the sum of accepted receiving lots.`);
	if (legacyCount > 0) issues.push(`${legacyCount} cartridge(s) still carry v1 status names (packeted/transferred/refrigerated/received) — migration is incomplete.`);

	// Build the legacy-shape "byKind" object the tool returns. Keep both
	// the per-kind enum names and the older camelCase aliases so existing
	// tool consumers don't break.
	const aliased: IntegritySummary['byKind'] = {
		nullWaxSourceLot: byKind['null_wax_source_lot'] ?? { count: 0, sample: [] },
		staleEquipmentReads: byKind['stale_temperature_read'] ?? { count: 0, sample: [] },
		stuckCartridges: byKind['stuck_cartridge'] ?? { count: 0, sample: [] },
		overConsumedLots: byKind['over_consumed_receiving_lot'] ?? { count: 0, sample: [] },
		orphanLotReferences: byKind['orphan_lot_reference'] ?? { count: 0, sample: [] },
		counterDrift: byKind['denormalized_counter_drift'] ?? { count: 0, sample: [] },
		legacyStatusCarriers: byKind['legacy_status_carrier'] ?? { count: 0, sample: [] },
		null_wax_source_lot: byKind['null_wax_source_lot'] ?? { count: 0, sample: [] },
		over_consumed_receiving_lot: byKind['over_consumed_receiving_lot'] ?? { count: 0, sample: [] },
		stale_temperature_read: byKind['stale_temperature_read'] ?? { count: 0, sample: [] },
		stuck_cartridge: byKind['stuck_cartridge'] ?? { count: 0, sample: [] },
		orphan_lot_reference: byKind['orphan_lot_reference'] ?? { count: 0, sample: [] },
		denormalized_counter_drift: byKind['denormalized_counter_drift'] ?? { count: 0, sample: [] },
		legacy_status_carrier: byKind['legacy_status_carrier'] ?? { count: 0, sample: [] }
	};

	return {
		totalIssueCount: issues.length,
		issues,
		byKind: aliased
	};
}

/**
 * Recompute path — runs every check and summarizes. Doesn't touch the
 * anomaly collection. Used by the tool's fallback when the persisted
 * collection is empty (first run, or the cron hasn't ticked yet).
 */
export async function computeSummary(): Promise<IntegritySummary> {
	const findings = await runAllChecks();
	return summarizeFindings(findings);
}

/**
 * Persist path — runs every check, upserts each finding into bims_anomalies
 * keyed by (kind, targetType, targetId), and marks rows that didn't appear
 * in this scan as resolved. Returns the same summary as `computeSummary`.
 */
export async function scanAndPersist(scanRunId: string): Promise<IntegritySummary> {
	const findings = await runAllChecks();
	const now = new Date();
	const seenKeys = new Set<string>();

	for (const f of findings) {
		const key = `${f.kind}::${f.targetType}::${f.targetId}`;
		seenKeys.add(key);
		await BimsAnomaly.updateOne(
			{ kind: f.kind, targetType: f.targetType, targetId: f.targetId },
			{
				$set: {
					severity: f.severity,
					details: f.details,
					lastSeenAt: now,
					scanRunId,
					resolvedAt: null
				},
				$setOnInsert: {
					_id: generateId(),
					firstSeenAt: now
				},
				$inc: { occurrenceCount: 1 }
			},
			{ upsert: true }
		);
	}

	// Mark anomalies that DIDN'T appear in this scan as resolved (only the
	// ones that were previously open). Limits the resolved-mark to checks the
	// scan actually ran — never auto-resolves something we didn't look at.
	const checkedKinds = Array.from(new Set(findings.map(f => f.kind)));
	if (checkedKinds.length > 0) {
		const stillOpen = await BimsAnomaly.find({
			kind: { $in: checkedKinds },
			resolvedAt: null
		}).select('_id kind targetType targetId').lean() as any[];

		const resolved: string[] = [];
		for (const a of stillOpen) {
			const key = `${a.kind}::${a.targetType}::${a.targetId}`;
			if (!seenKeys.has(key)) resolved.push(a._id);
		}
		if (resolved.length > 0) {
			await BimsAnomaly.updateMany(
				{ _id: { $in: resolved } },
				{ $set: { resolvedAt: now } }
			);
		}
	}

	return summarizeFindings(findings);
}

/**
 * Read path — summarize the OPEN (unresolved) anomalies that the cron has
 * already persisted. Returns null if the collection has no rows at all
 * (first run / cron hasn't ticked yet) so the tool knows to fall back.
 */
export async function summarizeFromAnomalies(): Promise<IntegritySummary | null> {
	const totalRows = await BimsAnomaly.estimatedDocumentCount();
	if (totalRows === 0) return null;

	const open = await BimsAnomaly.find({ resolvedAt: null })
		.select('kind targetType targetId severity details lastSeenAt')
		.lean() as any[];

	const findings: AnomalyFinding[] = open.map(a => ({
		kind: a.kind as AnomalyKind,
		targetType: a.targetType,
		targetId: a.targetId,
		severity: a.severity ?? 'warning',
		details: a.details ?? {}
	}));
	return summarizeFindings(findings);
}
