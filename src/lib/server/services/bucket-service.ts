/**
 * bucket-service.ts — every ProductionBucket / BucketCycle transition.
 *
 * This file is load-bearing (BUCKET-SYSTEM_PLAN.md §10): the bucket board,
 * the residual flow and WI-01 all go through these functions so there is
 * exactly one code path per transition. Do not duplicate transition logic
 * into route actions.
 *
 * Inventory rules (§3.3, §3.4, §8):
 *   - PT-CT-104 is debited ONCE, when the cycle opens at `raw`.
 *   - PT-CT-106 is debited ONCE, at pressed → qr_pending (labels applied).
 *   - PT-CT-112 (thermoseal) is never touched here — WI-01 keeps debiting it.
 *   - Scrap / adjust-down inside a bucket write NO InventoryTransaction: the
 *     units were already removed from part inventory when they entered the
 *     bucket. They are recorded on the bucket ledger (and, for scrap, as a
 *     ManualCartridgeRemoval) so loss is visible without double-debiting.
 *   - Adjust-UP records an extra consumption for the delta, because more
 *     material left part inventory than the cycle originally recorded.
 */
import { connectDB } from '$lib/server/db/connection';
import {
	ProductionBucket, BucketCycle, BucketTransaction, AuditLog,
	ReceivingLot, ManualCartridgeRemoval, CartridgeRecord
} from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { recordTransaction, resolvePartId } from './inventory-transaction';
import { generateBarcode } from './barcode-generator';

export const BUCKET_STAGES = ['raw', 'unpressed', 'pressed', 'qr_pending'] as const;
export type BucketStage = (typeof BUCKET_STAGES)[number];

export const STAGE_LABELS: Record<BucketStage, string> = {
	raw: 'Raw',
	unpressed: 'Unpressed',
	pressed: 'Pressed',
	qr_pending: 'QR Pending'
};

export const BUCKET_PREFIX = 'BKT';
export const CARTRIDGE_BLANK_PART = 'PT-CT-104';
export const BARCODE_LABEL_PART = 'PT-CT-106';

export type Operator = { _id: string; username: string };
export type ResidualDisposition = 'merge' | 'scrap' | 'defer';

export class BucketError extends Error {
	status: number;
	code?: string;
	constructor(message: string, status = 400, code?: string) {
		super(message);
		this.name = 'BucketError';
		this.status = status;
		this.code = code;
	}
}

export function isBucketStage(s: unknown): s is BucketStage {
	return typeof s === 'string' && (BUCKET_STAGES as readonly string[]).includes(s);
}

export function nextStage(stage: BucketStage): BucketStage | null {
	const i = BUCKET_STAGES.indexOf(stage);
	return i >= 0 && i < BUCKET_STAGES.length - 1 ? BUCKET_STAGES[i + 1] : null;
}

/** Scanned labels arrive in whatever case the scanner emits; ids are stored upper. */
export function normalizeBucketId(code: string): string {
	return (code ?? '').trim().toUpperCase();
}

export function cycleLabel(bucketId: string, cycleNumber: number): string {
	return `${bucketId} #${cycleNumber}`;
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertPositiveInt(n: unknown, label: string): number {
	const v = Number(n);
	if (!Number.isInteger(v) || v <= 0) throw new BucketError(`${label} must be a whole number greater than 0`);
	return v;
}

// ── ledger + audit helpers ────────────────────────────────────────────────

interface TxInput {
	bucketId: string;
	cycleId?: string | null;
	type: 'mint' | 'relabel' | 'create' | 'advance' | 'adjust' | 'scrap' | 'consume'
		| 'merge_in' | 'merge_out' | 'release' | 'quarantine' | 'retire';
	fromStage?: string | null;
	toStage?: string | null;
	qtyBefore?: number;
	qtyAfter?: number;
	reason?: string;
	journal?: string;
	relatedId?: string | null;
	operator: Operator;
}

async function logTx(tx: TxInput): Promise<string> {
	const id = generateId();
	const qtyBefore = tx.qtyBefore ?? 0;
	const qtyAfter = tx.qtyAfter ?? qtyBefore;
	await BucketTransaction.create({
		_id: id,
		bucketId: tx.bucketId,
		cycleId: tx.cycleId ?? undefined,
		type: tx.type,
		fromStage: tx.fromStage ?? undefined,
		toStage: tx.toStage ?? undefined,
		qtyBefore,
		qtyAfter,
		qtyDelta: qtyAfter - qtyBefore,
		reason: tx.reason,
		journal: tx.journal,
		relatedId: tx.relatedId ?? undefined,
		operator: { _id: tx.operator._id, username: tx.operator.username },
		createdAt: new Date()
	});
	return id;
}

async function audit(
	tableName: 'production_buckets' | 'bucket_cycles',
	recordId: string,
	action: string,
	user: Operator,
	newData?: unknown,
	oldData?: unknown,
	reason?: string
): Promise<void> {
	await AuditLog.create({
		_id: generateId(),
		tableName,
		recordId,
		action,
		changedBy: user.username,
		changedAt: new Date(),
		newData,
		oldData,
		reason
	});
}

// ── lookups ───────────────────────────────────────────────────────────────

/**
 * Same rule WI-01 applies to its input scans: the lot must exist in
 * receiving, belong to the expected part, and not be rejected/returned.
 */
export async function validateReceivingLot(lotId: string, partNumber: string):
	Promise<{ ok: true; lot: any } | { ok: false; reason: string }>
{
	const id = (lotId ?? '').trim();
	if (!id) return { ok: false, reason: 'Lot barcode is empty.' };
	const lot = await ReceivingLot.findOne({ lotId: id }).lean() as any;
	if (!lot) return { ok: false, reason: `Lot "${id}" is not in the receiving system.` };
	if (lot.part?.partNumber !== partNumber) {
		return { ok: false, reason: `Lot "${id}" is ${lot.part?.partNumber ?? 'an unknown part'} — expected ${partNumber}.` };
	}
	if (lot.status === 'rejected' || lot.status === 'returned') {
		return { ok: false, reason: `Lot "${id}" has status "${lot.status}" and cannot be consumed.` };
	}
	return { ok: true, lot };
}

export async function getOpenCycle(bucketId: string): Promise<any | null> {
	return BucketCycle.findOne({ bucketId, status: 'open' }).lean();
}

/**
 * Resolve any scanned code to a bucket _id: the printed BKT- id first, then
 * the assigned sticker (`barcode`). UUID stickers are matched as scanned and
 * in both cases, since scanners disagree about hex case. Null = not a bucket.
 */
export async function resolveBucketId(code: string): Promise<string | null> {
	await connectDB();
	const raw = (code ?? '').trim();
	if (!raw) return null;
	const byId = await ProductionBucket.findById(raw.toUpperCase()).select('_id').lean() as any;
	if (byId) return byId._id;
	const byBarcode = await ProductionBucket.findOne({ barcode: { $in: [raw, raw.toLowerCase(), raw.toUpperCase()] } })
		.select('_id').lean() as any;
	return byBarcode ? byBarcode._id : null;
}

/**
 * Guard for every place a CartridgeRecord is born. A bucket wearing a UUID
 * sticker looks exactly like a cartridge to a scanner; without this, scanning
 * a tub into a cartridge field would mint a phantom cartridge whose id is a
 * bucket's label.
 */
export async function assertNotBucketLabel(code: string): Promise<void> {
	const id = await resolveBucketId(code);
	if (id) throw new BucketError(`${(code ?? '').trim()} is the label on production bucket ${id}, not a cartridge.`, 409, 'BUCKET_LABEL');
}

export interface ScanResolution {
	kind: 'bucket' | 'search';
	bucket?: any;
	cycle?: any | null;
	matches?: { bucketId: string; barcode: string | null; state: string; cycle: any | null }[];
}

/**
 * One label, no modes (§9.1): an exact bucket id or assigned sticker resolves
 * to that bucket and its open cycle (if any); anything else becomes a short
 * search over ids and stickers so a partial scan or typed fragment still
 * lands somewhere useful.
 */
export async function resolveScan(code: string): Promise<ScanResolution> {
	await connectDB();
	const raw = (code ?? '').trim();
	if (!raw) return { kind: 'search', matches: [] };

	const id = await resolveBucketId(raw);
	if (id) {
		const bucket = await ProductionBucket.findById(id).lean() as any;
		const cycle = await getOpenCycle(id);
		return { kind: 'bucket', bucket, cycle };
	}

	const rx = { $regex: escapeRegExp(raw), $options: 'i' };
	const found = await ProductionBucket.find({ $or: [{ _id: rx }, { barcode: rx }] })
		.sort({ _id: 1 }).limit(10).lean() as any[];
	const openCycles = found.length
		? await BucketCycle.find({ bucketId: { $in: found.map(b => b._id) }, status: 'open' }).lean() as any[]
		: [];
	const cycleByBucket = new Map(openCycles.map(c => [c.bucketId, c]));
	return {
		kind: 'search',
		matches: found.map(b => ({ bucketId: b._id, barcode: b.barcode ?? null, state: b.state, cycle: cycleByBucket.get(b._id) ?? null }))
	};
}

// ── minting ───────────────────────────────────────────────────────────────

/**
 * Mint new bucket labels. Each becomes an `available` ProductionBucket
 * immediately: a tub with no cycles is harmless, and the BKT- counter is
 * consumed either way. Reprinting an existing id is a render-only concern
 * (see print-bucket-labels) — it never mints.
 */
export async function mintBuckets(count: number, user: Operator, homeLocation?: string): Promise<string[]> {
	await connectDB();
	const n = assertPositiveInt(count, 'Count');
	if (n > 50) throw new BucketError('Mint at most 50 bucket labels at a time');
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = await generateBarcode(BUCKET_PREFIX, 'bucket');
		await ProductionBucket.create({
			_id: id,
			state: 'available',
			cycleCount: 0,
			homeLocation: homeLocation || undefined,
			spotCheckPending: false,
			createdBy: { _id: user._id, username: user.username }
		});
		await logTx({ bucketId: id, type: 'mint', operator: user });
		await audit('production_buckets', id, 'INSERT', user, { state: 'available', homeLocation });
		ids.push(id);
	}
	return ids;
}

// A sticker stuck on a tub is one fewer available for cartridges. PT-CT-106's
// count is "printed labels on hand", so an assignment consumes one. No lotId —
// which sheet the sticker came from isn't knowable at the tub.
const CONSUME_LABEL_ON_ASSIGN = true;

export interface AssignBarcodeInput {
	bucketId: string; // BKT- id or the bucket's current sticker
	barcode: string;  // the sticker being applied
	user: Operator;
}

/**
 * Put a QR sticker on a bucket, or replace the one it has (§9.4). The BKT- id
 * is untouched, so history survives a relabel. Refuses a code that is already
 * a cartridge, another bucket's sticker, or a BKT- id.
 */
export async function assignBucketBarcode(input: AssignBarcodeInput): Promise<{ bucketId: string; barcode: string; previous: string | null }> {
	await connectDB();
	const bucketId = await resolveBucketId(input.bucketId);
	if (!bucketId) throw new BucketError(`"${(input.bucketId ?? '').trim()}" is not a known bucket.`, 404);
	const bucket = await ProductionBucket.findById(bucketId).lean() as any;
	if (bucket.state === 'retired') throw new BucketError(`Bucket ${bucketId} is retired.`);

	const code = (input.barcode ?? '').trim();
	if (!code) throw new BucketError('Scan the QR sticker.');
	if (/^BKT-\d+$/i.test(code)) throw new BucketError('That is a printed bucket id, not a sticker — scan a QR sticker.');
	if (bucket.barcode && bucket.barcode === code) throw new BucketError(`${code} is already on ${bucketId}.`);

	const cart = await CartridgeRecord.findById(code).select('_id status').lean() as any;
	if (cart) throw new BucketError(`${code} is already cartridge ${cart._id} (status ${cart.status ?? 'unknown'}) — use an unused sticker.`, 409);
	const other = await ProductionBucket.findOne({ barcode: code, _id: { $ne: bucketId } }).select('_id').lean() as any;
	if (other) throw new BucketError(`${code} is already on bucket ${other._id}.`, 409);

	const previous: string | null = bucket.barcode ?? null;
	try {
		await ProductionBucket.updateOne({ _id: bucketId }, { $set: { barcode: code } });
	} catch (e: any) {
		if (e?.code === 11000) throw new BucketError(`${code} was just assigned to another bucket.`, 409);
		throw e;
	}

	if (CONSUME_LABEL_ON_ASSIGN) {
		const partId = await resolvePartId(BARCODE_LABEL_PART);
		await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: partId ?? undefined,
			quantity: 1,
			manufacturingStep: 'backing',
			manufacturingRunId: bucketId,
			operatorId: input.user._id,
			operatorUsername: input.user.username,
			notes: `1x ${BARCODE_LABEL_PART} sticker ${code} ${previous ? `replaced ${previous} on` : 'assigned to'} bucket ${bucketId}`
		});
	}

	await logTx({
		bucketId, type: 'relabel',
		reason: previous ? `sticker replaced: ${previous} → ${code}` : `sticker assigned: ${code}`,
		relatedId: code, operator: input.user
	});
	await audit('production_buckets', bucketId, 'RELABEL', input.user, { barcode: code }, { barcode: previous });
	return { bucketId, barcode: code, previous };
}

// ── cycle lifecycle ───────────────────────────────────────────────────────

async function closeCycle(cycle: any, status: 'consumed' | 'scrapped', user: Operator, relatedId?: string): Promise<void> {
	const now = new Date();
	await BucketCycle.updateOne({ _id: cycle._id }, { $set: { status, closedAt: now, quantity: 0 } });
	// Auto-release with deferred spot-check (§3.5): the tub goes straight back
	// to the available pool; the empty-check happens at the next Start Cycle.
	await ProductionBucket.updateOne(
		{ _id: cycle.bucketId },
		{ $set: { state: 'available', currentCycleId: null, spotCheckPending: true } }
	);
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'release',
		fromStage: cycle.stage, toStage: cycle.stage, qtyBefore: 0, qtyAfter: 0,
		reason: `cycle ${status}`, relatedId, operator: user
	});
	await audit('bucket_cycles', cycle._id, 'CLOSE', user, { status, closedAt: now });
}

export interface StartCycleInput {
	bucketId: string;
	quantity: number;
	sourceLotId: string;      // PT-CT-104 ReceivingLot.lotId
	emptyConfirmed?: boolean; // required when the bucket has spotCheckPending
	user: Operator;
}

export async function startCycle(input: StartCycleInput): Promise<any> {
	await connectDB();
	const quantity = assertPositiveInt(input.quantity, 'Quantity');
	const bucketId = await resolveBucketId(input.bucketId);
	if (!bucketId) throw new BucketError(`"${(input.bucketId ?? '').trim()}" is not a bucket id or an assigned bucket sticker — mint or assign its label first.`, 404);

	const bucket = await ProductionBucket.findById(bucketId).lean() as any;
	if (bucket.state === 'retired') throw new BucketError(`Bucket ${bucketId} is retired.`);
	if (bucket.state === 'in_use') throw new BucketError(`Bucket ${bucketId} already holds an open cycle.`, 409);
	if (bucket.state === 'quarantined') {
		throw new BucketError(`Bucket ${bucketId} has undispositioned contents (${bucket.residualNote ?? 'residual'}) — disposition them first.`, 409, 'QUARANTINED');
	}
	if (bucket.spotCheckPending && !input.emptyConfirmed) {
		throw new BucketError('Confirm the tub is empty before starting a new cycle.', 409, 'SPOT_CHECK');
	}

	const lotCheck = await validateReceivingLot(input.sourceLotId, CARTRIDGE_BLANK_PART);
	if (!lotCheck.ok) throw new BucketError(lotCheck.reason);

	const now = new Date();
	const cycleNumber = (bucket.cycleCount ?? 0) + 1;
	const cycleId = generateId();
	try {
		await BucketCycle.create({
			_id: cycleId,
			bucketId,
			cycleNumber,
			stage: 'raw',
			quantity,
			openedQty: quantity,
			sourceLots: [{ partNumber: CARTRIDGE_BLANK_PART, lotId: lotCheck.lot.lotId, scannedAt: now }],
			status: 'open',
			...(bucket.spotCheckPending
				? { emptyConfirmedBy: { _id: input.user._id, username: input.user.username }, emptyConfirmedAt: now }
				: {}),
			openedBy: { _id: input.user._id, username: input.user.username },
			openedAt: now,
			stageEnteredAt: now
		});
	} catch (e: any) {
		// Partial unique index on { bucketId } where status='open' — the DB-level
		// guarantee against two operators opening the same tub at once.
		if (e?.code === 11000) throw new BucketError(`Bucket ${bucketId} already holds an open cycle.`, 409);
		throw e;
	}

	await ProductionBucket.updateOne(
		{ _id: bucketId },
		{ $set: { state: 'in_use', currentCycleId: cycleId, spotCheckPending: false }, $inc: { cycleCount: 1 } }
	);

	// The ONLY PT-CT-104 debit for these units (§8).
	const partId = await resolvePartId(CARTRIDGE_BLANK_PART);
	await recordTransaction({
		transactionType: 'consumption',
		partDefinitionId: partId ?? undefined,
		lotId: lotCheck.lot.lotId,
		quantity,
		manufacturingStep: 'backing',
		manufacturingRunId: cycleId,
		operatorId: input.user._id,
		operatorUsername: input.user.username,
		notes: `Bucket ${cycleLabel(bucketId, cycleNumber)} opened at raw: ${quantity}x ${CARTRIDGE_BLANK_PART} from lot ${lotCheck.lot.lotId}`
	});

	await logTx({
		bucketId, cycleId, type: 'create', fromStage: null, toStage: 'raw',
		qtyBefore: 0, qtyAfter: quantity, relatedId: lotCheck.lot.lotId, operator: input.user
	});
	await audit('bucket_cycles', cycleId, 'INSERT', input.user, {
		bucketId, cycleNumber, quantity, sourceLot: lotCheck.lot.lotId, emptyConfirmed: !!bucket.spotCheckPending
	});

	return BucketCycle.findById(cycleId).lean();
}

export interface AdvanceCycleInput {
	cycleId: string;
	user: Operator;
	barcodeLotId?: string;  // PT-CT-106 lot, required for pressed → qr_pending
}

export async function advanceCycle(input: AdvanceCycleInput): Promise<any> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Cycle is not open.', 404);
	const from = cycle.stage as BucketStage;
	const to = nextStage(from);
	if (!to) throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is already at QR Pending — WI-01 consumes from here.`);

	const now = new Date();
	const set: Record<string, unknown> = { stage: to, stageEnteredAt: now };
	const push: Record<string, unknown> = {};
	let relatedId: string | undefined;

	// unpressed → pressed records nothing extra (no press capture, no
	// thermoseal debit — §3.4); it is a plain stage move.
	if (to === 'qr_pending') {
		const lotCheck = await validateReceivingLot(input.barcodeLotId ?? '', BARCODE_LABEL_PART);
		if (!lotCheck.ok) throw new BucketError(lotCheck.reason);
		push.sourceLots = { partNumber: BARCODE_LABEL_PART, lotId: lotCheck.lot.lotId, scannedAt: now };
		relatedId = lotCheck.lot.lotId;
		// The ONLY PT-CT-106 debit for these units — WI-01 must NOT debit it
		// again for a bucket-sourced batch (§6.3).
		const partId = await resolvePartId(BARCODE_LABEL_PART);
		await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: partId ?? undefined,
			lotId: lotCheck.lot.lotId,
			quantity: cycle.quantity,
			manufacturingStep: 'backing',
			manufacturingRunId: cycle._id,
			operatorId: input.user._id,
			operatorUsername: input.user.username,
			notes: `Bucket ${cycleLabel(cycle.bucketId, cycle.cycleNumber)} labels applied: ${cycle.quantity}x ${BARCODE_LABEL_PART} from lot ${lotCheck.lot.lotId}`
		});
	}

	await BucketCycle.updateOne(
		{ _id: cycle._id },
		{ $set: set, ...(Object.keys(push).length ? { $push: push } : {}) }
	);
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'advance',
		fromStage: from, toStage: to, qtyBefore: cycle.quantity, qtyAfter: cycle.quantity,
		relatedId, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'ADVANCE', input.user, { from, to, ...set });
	return BucketCycle.findById(cycle._id).lean();
}

export interface AdjustCycleInput {
	cycleId: string;
	newQuantity: number;
	reason: string;
	user: Operator;
}

/**
 * Physical recount disagrees with the record (§3.1). Never to zero — use
 * scrap to empty a bucket, so the loss gets a journal entry.
 */
export async function adjustCycle(input: AdjustCycleInput): Promise<any> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Cycle is not open.', 404);
	const newQty = assertPositiveInt(input.newQuantity, 'New quantity');
	const reason = (input.reason ?? '').trim();
	if (!reason) throw new BucketError('A reason is required for a count correction.');
	const delta = newQty - cycle.quantity;
	if (delta === 0) throw new BucketError('New quantity matches the current count — nothing to adjust.');

	if (delta > 0) {
		// More material left part inventory than the cycle recorded at open /
		// label time. Record the extra consumption against the same lots.
		const blankLot = (cycle.sourceLots ?? []).find((l: any) => l.partNumber === CARTRIDGE_BLANK_PART)?.lotId;
		const blankPartId = await resolvePartId(CARTRIDGE_BLANK_PART);
		await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: blankPartId ?? undefined,
			lotId: blankLot,
			quantity: delta,
			manufacturingStep: 'backing',
			manufacturingRunId: cycle._id,
			operatorId: input.user._id,
			operatorUsername: input.user.username,
			notes: `Bucket ${cycleLabel(cycle.bucketId, cycle.cycleNumber)} count corrected +${delta} (${reason})`
		});
		if (cycle.stage === 'qr_pending') {
			const labelLot = (cycle.sourceLots ?? []).find((l: any) => l.partNumber === BARCODE_LABEL_PART)?.lotId;
			const labelPartId = await resolvePartId(BARCODE_LABEL_PART);
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: labelPartId ?? undefined,
				lotId: labelLot,
				quantity: delta,
				manufacturingStep: 'backing',
				manufacturingRunId: cycle._id,
				operatorId: input.user._id,
				operatorUsername: input.user.username,
				notes: `Bucket ${cycleLabel(cycle.bucketId, cycle.cycleNumber)} count corrected +${delta} labels (${reason})`
			});
		}
	}
	// delta < 0: units already left part inventory when they entered the
	// bucket; the ledger records the correction, nothing else moves.

	await BucketCycle.updateOne({ _id: cycle._id }, { $set: { quantity: newQty } });
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'adjust',
		fromStage: cycle.stage, toStage: cycle.stage, qtyBefore: cycle.quantity, qtyAfter: newQty,
		reason, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'ADJUST', input.user, { quantity: newQty }, { quantity: cycle.quantity }, reason);
	return BucketCycle.findById(cycle._id).lean();
}

export interface ScrapInput {
	cycleId: string;
	quantity: number;
	journal: string;
	user: Operator;
	relatedId?: string; // LotRecord._id when scrapped during WI-01
}

/**
 * Units lost from an open cycle. Writes a ManualCartridgeRemoval so the
 * loss shows in Recent Checkouts next to every other removal; writes NO
 * InventoryTransaction (already debited at open / label time).
 */
export async function scrapFromCycle(input: ScrapInput): Promise<{ cycle: any; removalId: string }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Cycle is not open.', 404);
	const qty = assertPositiveInt(input.quantity, 'Scrap quantity');
	if (qty > cycle.quantity) throw new BucketError(`Cannot scrap ${qty} — the bucket only holds ${cycle.quantity}.`);
	const journal = (input.journal ?? '').trim();
	if (!journal) throw new BucketError('A journal entry describing why these were scrapped is required.');

	const now = new Date();
	const removalId = generateId();
	await ManualCartridgeRemoval.create({
		_id: removalId,
		cartridgeIds: [],
		bucketCycleId: cycle._id,
		bucketId: cycle.bucketId,
		cartridgeCount: qty,
		reason: journal,
		journal,
		operator: { _id: input.user._id, username: input.user.username },
		removedAt: now
	});

	const after = cycle.quantity - qty;
	await BucketCycle.updateOne({ _id: cycle._id }, { $set: { quantity: after } });
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'scrap',
		fromStage: cycle.stage, toStage: cycle.stage, qtyBefore: cycle.quantity, qtyAfter: after,
		reason: journal, journal, relatedId: input.relatedId ?? removalId, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'SCRAP', input.user, { scrapped: qty, quantity: after, removalId }, { quantity: cycle.quantity }, journal);

	if (after === 0) await closeCycle({ ...cycle, quantity: 0 }, 'scrapped', input.user, removalId);
	return { cycle: await BucketCycle.findById(cycle._id).lean(), removalId };
}

export interface ConsumeInput {
	cycleId: string;
	quantity: number;   // cartridges actually serialized by WI-01
	lotRecordId: string;
	user: Operator;
}

/**
 * WI-01 handoff (§6.3). Partial consumption is allowed: the cycle stays open
 * at qr_pending with whatever remains. Scanning MORE than the cycle held is
 * an overrun discrepancy — recorded, never blocked, because the scans are the
 * physical truth and the count was the estimate.
 */
export async function consumeFromCycle(input: ConsumeInput): Promise<{ qtyBefore: number; qtyAfter: number; overrun: number }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Cycle is not open.', 404);
	if (cycle.stage !== 'qr_pending') {
		throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is at ${STAGE_LABELS[cycle.stage as BucketStage]} — only QR Pending buckets can be consumed at WI-01.`);
	}
	const qty = assertPositiveInt(input.quantity, 'Consumed quantity');
	const before: number = cycle.quantity;
	const after = Math.max(0, before - qty);
	const overrun = Math.max(0, qty - before);
	const now = new Date();

	const update: Record<string, unknown> = { $set: { quantity: after } };
	if (overrun > 0) {
		update.$push = {
			discrepancies: {
				type: 'overrun', qty: overrun, relatedId: input.lotRecordId, at: now,
				note: `WI-01 lot ${input.lotRecordId} serialized ${qty} but the cycle recorded ${before}`
			}
		};
	}
	await BucketCycle.updateOne({ _id: cycle._id }, update);
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'consume',
		fromStage: 'qr_pending', toStage: 'qr_pending', qtyBefore: before, qtyAfter: after,
		reason: overrun > 0 ? `overrun by ${overrun}` : undefined,
		relatedId: input.lotRecordId, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'CONSUME', input.user, { consumed: qty, quantity: after, overrun, lotRecordId: input.lotRecordId }, { quantity: before });

	if (after === 0) await closeCycle({ ...cycle, quantity: 0 }, 'consumed', input.user, input.lotRecordId);
	return { qtyBefore: before, qtyAfter: after, overrun };
}

// ── residual flow (§7) ────────────────────────────────────────────────────

export interface ResidualInput {
	bucketId: string;
	quantity: number;
	stage: BucketStage;
	disposition: ResidualDisposition;
	destinationBucketId?: string; // merge
	journal?: string;             // required for scrap; optional note for defer
	user: Operator;
}

export async function reportResidual(input: ResidualInput): Promise<{ bucket: any; prevCycle: any | null }> {
	await connectDB();
	const qty = assertPositiveInt(input.quantity, 'Residual count');
	if (!isBucketStage(input.stage)) throw new BucketError('Pick the stage the leftover cartridges are at.');
	const bucketId = await resolveBucketId(input.bucketId);
	if (!bucketId) throw new BucketError(`"${(input.bucketId ?? '').trim()}" is not a known bucket.`, 404);

	const bucket = await ProductionBucket.findById(bucketId).lean() as any;
	if (bucket.state === 'in_use') throw new BucketError(`Bucket ${bucketId} has an open cycle — use Adjust on that cycle instead of reporting a residual.`);
	if (bucket.state === 'retired') throw new BucketError(`Bucket ${bucketId} is retired.`);

	// The pass these leftovers most plausibly came from. May be null for a tub
	// that was never cycled — the residual is then recorded on the bucket only.
	const prevCycle = await BucketCycle.findOne({ bucketId }).sort({ cycleNumber: -1 }).lean() as any;
	const now = new Date();
	const by = { _id: input.user._id, username: input.user.username };
	const found: Record<string, unknown> = { qty, stage: input.stage, disposition: input.disposition, at: now, by };
	let relatedId: string | undefined;

	if (input.disposition === 'merge') {
		const destRaw = (input.destinationBucketId ?? '').trim();
		if (!destRaw) throw new BucketError('Scan the destination bucket.');
		const destId = await resolveBucketId(destRaw);
		if (!destId) throw new BucketError(`"${destRaw}" is not a known bucket.`, 404);
		if (destId === bucketId) throw new BucketError('Destination must be a different bucket.');
		const dest = await getOpenCycle(destId);
		if (!dest) throw new BucketError(`Bucket ${destId} has no open cycle to merge into.`);
		if (dest.stage !== input.stage) {
			throw new BucketError(`Bucket ${destId} is at ${STAGE_LABELS[dest.stage as BucketStage]} — residuals can only merge into a bucket at ${STAGE_LABELS[input.stage]}.`);
		}
		await BucketCycle.updateOne({ _id: dest._id }, { $set: { quantity: dest.quantity + qty } });
		await logTx({
			bucketId: destId, cycleId: dest._id, type: 'merge_in',
			fromStage: input.stage, toStage: input.stage, qtyBefore: dest.quantity, qtyAfter: dest.quantity + qty,
			reason: `residual from ${bucketId}${prevCycle ? ` #${prevCycle.cycleNumber}` : ''}`,
			relatedId: prevCycle?._id ?? bucketId, operator: input.user
		});
		await logTx({
			bucketId, cycleId: prevCycle?._id ?? null, type: 'merge_out',
			fromStage: input.stage, toStage: input.stage, qtyBefore: qty, qtyAfter: 0,
			reason: `residual merged into ${cycleLabel(destId, dest.cycleNumber)}`,
			relatedId: dest._id, operator: input.user
		});
		found.destinationCycleId = dest._id;
		relatedId = dest._id;
		await audit('bucket_cycles', dest._id, 'MERGE_IN', input.user, { from: bucketId, qty, quantity: dest.quantity + qty }, { quantity: dest.quantity });
	} else if (input.disposition === 'scrap') {
		const journal = (input.journal ?? '').trim();
		if (!journal) throw new BucketError('A journal entry describing why these were scrapped is required.');
		const removalId = generateId();
		await ManualCartridgeRemoval.create({
			_id: removalId,
			cartridgeIds: [],
			bucketCycleId: prevCycle?._id,
			bucketId,
			cartridgeCount: qty,
			reason: journal,
			journal,
			operator: by,
			removedAt: now
		});
		await logTx({
			bucketId, cycleId: prevCycle?._id ?? null, type: 'scrap',
			fromStage: input.stage, toStage: input.stage, qtyBefore: qty, qtyAfter: 0,
			reason: journal, journal, relatedId: removalId, operator: input.user
		});
		found.removalId = removalId;
		relatedId = removalId;
	} else if (input.disposition === 'defer') {
		const note = `${qty} × ${STAGE_LABELS[input.stage]}${input.journal?.trim() ? ` — ${input.journal.trim()}` : ''}`;
		await ProductionBucket.updateOne(
			{ _id: bucketId },
			{ $set: { state: 'quarantined', residualNote: note, spotCheckPending: false } }
		);
		await logTx({
			bucketId, cycleId: prevCycle?._id ?? null, type: 'quarantine',
			fromStage: input.stage, toStage: input.stage, qtyBefore: qty, qtyAfter: qty,
			reason: note, operator: input.user
		});
	} else {
		throw new BucketError('Unknown disposition.');
	}

	if (input.disposition !== 'defer') {
		await ProductionBucket.updateOne(
			{ _id: bucketId },
			{ $set: { state: 'available', spotCheckPending: false }, $unset: { residualNote: 1 } }
		);
	}

	// Never rewrite the closed cycle's quantity (§7.1) — append what was found.
	if (prevCycle) {
		await BucketCycle.updateOne(
			{ _id: prevCycle._id },
			{
				$set: { closedWithResidual: true },
				$push: {
					residualFound: found,
					discrepancies: {
						type: 'shortfall', qty, relatedId, at: now,
						note: `${qty} found in tub after close — dispositioned as ${input.disposition}`
					}
				}
			}
		);
		await audit('bucket_cycles', prevCycle._id, 'RESIDUAL', input.user, found);
	}
	await audit('production_buckets', bucketId, 'RESIDUAL', input.user, { qty, stage: input.stage, disposition: input.disposition, relatedId });

	return { bucket: await ProductionBucket.findById(bucketId).lean(), prevCycle: prevCycle ? await BucketCycle.findById(prevCycle._id).lean() : null };
}

export async function retireBucket(bucketId: string, reason: string, user: Operator): Promise<void> {
	await connectDB();
	const id = await resolveBucketId(bucketId);
	if (!id) throw new BucketError(`"${(bucketId ?? '').trim()}" is not a known bucket.`, 404);
	const bucket = await ProductionBucket.findById(id).lean() as any;
	if (bucket.state === 'in_use') throw new BucketError('Drain or scrap the open cycle before retiring this bucket.');
	if (bucket.state === 'retired') throw new BucketError('Already retired.');
	const why = (reason ?? '').trim();
	if (!why) throw new BucketError('A reason is required to retire a bucket.');
	await ProductionBucket.updateOne({ _id: id }, { $set: { state: 'retired', retiredAt: new Date(), retiredReason: why } });
	await logTx({ bucketId: id, type: 'retire', reason: why, operator: user });
	await audit('production_buckets', id, 'RETIRE', user, { state: 'retired' }, { state: bucket.state }, why);
}

// ── read models for the board, the dashboard strip and the pipeline ──────

export interface StageCounts {
	stages: Record<BucketStage, { buckets: number; cartridges: number }>;
	available: number;
	inUse: number;
	quarantined: number;
	retired: number;
}

export async function stageCounts(): Promise<StageCounts> {
	await connectDB();
	const [cycleAgg, bucketAgg] = await Promise.all([
		BucketCycle.aggregate([
			{ $match: { status: 'open' } },
			{ $group: { _id: '$stage', buckets: { $sum: 1 }, cartridges: { $sum: '$quantity' } } }
		]) as any as Promise<any[]>,
		ProductionBucket.aggregate([
			{ $group: { _id: '$state', n: { $sum: 1 } } }
		]) as any as Promise<any[]>
	]);
	const stages = Object.fromEntries(BUCKET_STAGES.map(s => [s, { buckets: 0, cartridges: 0 }])) as StageCounts['stages'];
	for (const row of cycleAgg) {
		const stage: unknown = row._id; // hoist so the type guard narrows a real binding, not an `any` property access
		if (isBucketStage(stage)) stages[stage] = { buckets: row.buckets ?? 0, cartridges: row.cartridges ?? 0 };
	}
	const byState = new Map(bucketAgg.map(r => [r._id, r.n ?? 0]));
	return {
		stages,
		available: byState.get('available') ?? 0,
		inUse: byState.get('in_use') ?? 0,
		quarantined: byState.get('quarantined') ?? 0,
		retired: byState.get('retired') ?? 0
	};
}

export interface BoardCycle {
	cycleId: string;
	bucketId: string;
	barcode: string | null; // the tub's sticker, so the scan rail resolves either label
	cycleNumber: number;
	stage: BucketStage;
	quantity: number;
	openedQty: number;
	stageEnteredAt: string | null;
	openedAt: string | null;
	openedBy: string | null;
	sourceLots: { partNumber: string; lotId: string }[];
}

export interface BoardBucket {
	bucketId: string;
	barcode: string | null;
	state: string;
	cycleCount: number;
	spotCheckPending: boolean;
	residualNote: string | null;
	homeLocation: string | null;
	lastStage: BucketStage | null; // stage the previous cycle closed at — default for the residual prompt (§7 step 1)
}

export async function boardData(): Promise<{ cycles: BoardCycle[]; available: BoardBucket[]; quarantined: BoardBucket[] }> {
	await connectDB();
	const [cycles, buckets, inUse] = await Promise.all([
		BucketCycle.find({ status: 'open' }).sort({ stageEnteredAt: 1 }).lean() as any as Promise<any[]>,
		ProductionBucket.find({ state: { $in: ['available', 'quarantined'] } }).sort({ _id: 1 }).lean() as any as Promise<any[]>,
		ProductionBucket.find({ state: 'in_use' }).select('_id barcode').lean() as any as Promise<any[]>
	]);
	const barcodeByBucket = new Map<string, string | null>(inUse.map(b => [b._id, b.barcode ?? null]));
	// Latest closed cycle per idle bucket → the stage its leftovers are most
	// plausibly at. One aggregate instead of a query per bucket.
	const lastStageByBucket = new Map<string, BucketStage>();
	if (buckets.length) {
		const last = await BucketCycle.aggregate([
			{ $match: { bucketId: { $in: buckets.map(b => b._id) } } },
			{ $sort: { cycleNumber: -1 } },
			{ $group: { _id: '$bucketId', stage: { $first: '$stage' } } }
		]) as any[];
		for (const row of last) if (isBucketStage(row.stage)) lastStageByBucket.set(row._id, row.stage);
	}
	const toBucket = (b: any): BoardBucket => ({
		bucketId: b._id,
		barcode: b.barcode ?? null,
		state: b.state,
		cycleCount: b.cycleCount ?? 0,
		spotCheckPending: !!b.spotCheckPending,
		residualNote: b.residualNote ?? null,
		homeLocation: b.homeLocation ?? null,
		lastStage: lastStageByBucket.get(b._id) ?? null
	});
	return {
		cycles: cycles.map(c => ({
			cycleId: c._id,
			bucketId: c.bucketId,
			barcode: barcodeByBucket.get(c.bucketId) ?? null,
			cycleNumber: c.cycleNumber,
			stage: c.stage,
			quantity: c.quantity,
			openedQty: c.openedQty,
			stageEnteredAt: c.stageEnteredAt ? new Date(c.stageEnteredAt).toISOString() : null,
			openedAt: c.openedAt ? new Date(c.openedAt).toISOString() : null,
			openedBy: c.openedBy?.username ?? null,
			sourceLots: (c.sourceLots ?? []).map((l: any) => ({ partNumber: l.partNumber, lotId: l.lotId }))
		})),
		available: buckets.filter(b => b.state === 'available').map(toBucket),
		quarantined: buckets.filter(b => b.state === 'quarantined').map(toBucket)
	};
}

/** Full history for one tub: every cycle it has held, plus the ledger. */
export async function bucketHistory(bucketId: string): Promise<{ bucket: any; cycles: any[]; transactions: any[]; removals: any[] } | null> {
	await connectDB();
	const id = await resolveBucketId(bucketId); // accepts the BKT- id or the tub's sticker
	if (!id) return null;
	const bucket = await ProductionBucket.findById(id).lean() as any;
	const [cycles, transactions, removals] = await Promise.all([
		BucketCycle.find({ bucketId: id }).sort({ cycleNumber: -1 }).lean(),
		BucketTransaction.find({ bucketId: id }).sort({ createdAt: -1 }).limit(500).lean(),
		ManualCartridgeRemoval.find({ bucketId: id }).sort({ removedAt: -1 }).lean()
	]);
	return { bucket, cycles, transactions, removals };
}
