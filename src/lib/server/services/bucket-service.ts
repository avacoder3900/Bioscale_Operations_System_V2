/**
 * bucket-service.ts — every ProductionBucket / BucketCycle transition (v2).
 *
 * This file is load-bearing (BUCKET-SYSTEM_PLAN.md §10): the bucket board,
 * the residual flow and WI-01 all go through these functions so there is
 * exactly one code path per transition. Do not duplicate transition logic
 * into route actions.
 *
 * v2 model (user decision 2026-09-23):
 *   - The FIRST step is putting a QR sticker on each raw shell and scanning it
 *     into a bucket. That scan is the cartridge's birth: a CartridgeRecord is
 *     created at status 'raw'. A bucket pass is therefore a MEMBERSHIP LIST of
 *     cartridge ids, not a count.
 *   - Stages: raw → unpressed → pressed inside the bucket, then WI-01 draws
 *     cartridges out to 'backing', displayed as "In Oven". No oven equipment,
 *     no oven entry time, no cure-time gate anywhere.
 *   - Advancing a bucket advances every member's status. Discards, residuals
 *     and WI-01 draws are all "scan the cart" — the system knows exactly
 *     which cartridges exist.
 *
 * Inventory (the scan-in is the truth):
 *   - scan a cart into a bucket  → −1 PT-CT-104 (shell) and −1 PT-CT-106 (label)
 *   - raw → unpressed            → thermoseal by LENGTH: members × 3.75 cm off the open
 *                                  roll; a roll pull (−1 PT-CT-112) only when one runs out
 *   - discard / residual scrap   → scrap of what the cart physically is at that
 *                                  stage (shell + label; thermoseal length is not returned)
 *   - WI-01 draw                 → nothing; everything was debited upstream
 *   - un-scan a mis-scanned raw cart → the shell + label debits are retracted
 */
import { connectDB } from '$lib/server/db/connection';
import {
	ProductionBucket, BucketCycle, BucketTransaction, AuditLog,
	ReceivingLot, ManualCartridgeRemoval, CartridgeRecord,
	InventoryTransaction, PartDefinition
} from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { recordTransaction, resolvePartId } from './inventory-transaction';
import { generateBarcode } from './barcode-generator';
import { consumeThermoseal, creditThermoseal, ThermosealError, type ConsumeResult } from './thermoseal-service';

export const BUCKET_STAGES = ['raw', 'unpressed', 'pressed'] as const;
export type BucketStage = (typeof BUCKET_STAGES)[number];

export const STAGE_LABELS: Record<BucketStage, string> = {
	raw: 'Raw',
	unpressed: 'Unpressed',
	pressed: 'Pressed'
};

/** After the bucket: WI-01 draws cartridges into this CartridgeRecord status. */
export const IN_OVEN_STATUS = 'backing';
export const IN_OVEN_LABEL = 'In Oven';

export const BUCKET_PREFIX = 'BKT';
export const SHELL_PART = 'PT-CT-104';
export const LABEL_PART = 'PT-CT-106';
export const THERMOSEAL_PART = 'PT-CT-112';

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

export function cycleLabel(bucketId: string, cycleNumber: number): string {
	return `${bucketId} #${cycleNumber}`;
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanCodes(codes: string[] | undefined | null): string[] {
	return Array.from(new Set((codes ?? []).map(c => (c ?? '').trim()).filter(Boolean)));
}

// ── ledger + audit helpers ────────────────────────────────────────────────

interface TxInput {
	bucketId: string;
	cycleId?: string | null;
	type: 'mint' | 'relabel' | 'create' | 'scan_in' | 'unscan' | 'advance' | 'scrap' | 'consume'
		| 'merge_in' | 'merge_out' | 'release' | 'quarantine' | 'retire' | 'void';
	fromStage?: string | null;
	toStage?: string | null;
	qtyBefore?: number;
	qtyAfter?: number;
	reason?: string;
	journal?: string;
	relatedId?: string | null;
	cartridgeIds?: string[];
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
		cartridgeIds: tx.cartridgeIds?.length ? tx.cartridgeIds : undefined,
		operator: { _id: tx.operator._id, username: tx.operator.username },
		createdAt: new Date()
	});
	return id;
}

async function audit(
	tableName: 'production_buckets' | 'bucket_cycles' | 'cartridge_records',
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

// ── inventory helpers ─────────────────────────────────────────────────────

async function debit(partNumber: string, lotId: string | undefined, quantity: number, cycleId: string, user: Operator, notes: string): Promise<void> {
	if (quantity <= 0) return;
	const partId = await resolvePartId(partNumber);
	await recordTransaction({
		transactionType: 'consumption',
		partDefinitionId: partId ?? undefined,
		lotId,
		quantity,
		manufacturingStep: 'backing',
		manufacturingRunId: cycleId,
		operatorId: user._id,
		operatorUsername: user.username,
		notes
	});
}

async function debitScrap(partNumber: string, lotId: string | undefined, quantity: number, cycleId: string | null, user: Operator, reason: string, notes: string): Promise<void> {
	if (quantity <= 0) return;
	const partId = await resolvePartId(partNumber);
	await recordTransaction({
		transactionType: 'scrap',
		partDefinitionId: partId ?? undefined,
		lotId,
		quantity,
		manufacturingStep: 'scrap',
		manufacturingRunId: cycleId ?? undefined,
		operatorId: user._id,
		operatorUsername: user.username,
		scrapReason: reason,
		scrapCategory: 'other',
		notes
	});
}

/**
 * Reverse an earlier debit: a NEGATIVE row of the same type against the same
 * lot, plus $inc on the part. Negative-of-same-type is deliberate — per-lot
 * "N left" sums consumption+scrap rows per lot, so an `adjustment` would fix
 * the part total but leave the lot looking consumed. Written directly rather
 * than via recordTransaction, which applies Math.abs and would debit again.
 */
async function retract(type: 'consumption' | 'scrap', partDefinitionId: string | null, lotId: string | null, quantity: number, cycleId: string, user: Operator, note: string): Promise<void> {
	if (quantity <= 0) return;
	let previousQuantity = 0;
	if (partDefinitionId) {
		const part = await PartDefinition.findById(partDefinitionId).select('inventoryCount').lean() as any;
		previousQuantity = part?.inventoryCount ?? 0;
		await PartDefinition.updateOne({ _id: partDefinitionId }, { $inc: { inventoryCount: quantity } });
	}
	const now = new Date();
	await InventoryTransaction.create({
		_id: generateId(),
		transactionType: type,
		partDefinitionId: partDefinitionId ?? undefined,
		lotId: lotId ?? undefined,
		quantity: -quantity,
		previousQuantity,
		newQuantity: previousQuantity + quantity,
		manufacturingStep: type === 'scrap' ? 'scrap' : 'backing',
		manufacturingRunId: cycleId,
		operatorId: user._id,
		operatorUsername: user.username,
		performedBy: user.username,
		performedAt: now,
		notes: note,
		reason: note,
		retractedBy: user.username,
		retractedAt: now,
		retractionReason: note
	});
}

/** What a cartridge physically is at a bucket stage — the parts a discard removes.
 *  Thermoseal is deliberately absent: it is consumed by length off a roll
 *  (thermoseal-service), and a discarded cart does not put length back. */
function partsAtStage(stage: BucketStage): string[] {
	return [SHELL_PART, LABEL_PART];
}

function lotFor(sourceLots: { partNumber?: string; lotId?: string }[] | undefined, partNumber: string): string | undefined {
	return (sourceLots ?? []).find(l => l.partNumber === partNumber)?.lotId;
}

// ── lookups ───────────────────────────────────────────────────────────────

/**
 * Same rule WI-01 applied to its input scans: the lot must exist in
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
 * Resolve any scanned code to a bucket _id: the internal BKT- id first, then
 * the QR sticker on the tub (`barcode`). UUID stickers are matched as scanned
 * and in both cases, since scanners disagree about hex case. Null = not a bucket.
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
	if (id) throw new BucketError(`${(code ?? '').trim()} is the QR sticker on production bucket ${id}, not a cartridge.`, 409, 'BUCKET_LABEL');
}

/**
 * Batched form of the guard, for genesis paths that create many cartridges at
 * once (deck loads that upsert stubs via bulkWrite). One query for the whole
 * list; returns scanned code → bucket id for every code that is a bucket label.
 *
 * NOTE for whoever adds a new cartridge-creating path: search for
 * `bulkWrite` + `upsert: true` / `$setOnInsert`, not just `.create(`.
 */
export async function findBucketLabels(codes: string[]): Promise<Map<string, string>> {
	await connectDB();
	const out = new Map<string, string>();
	const cleaned = cleanCodes(codes);
	if (cleaned.length === 0) return out;
	const ids = cleaned.map(c => c.toUpperCase());
	const variants = Array.from(new Set(cleaned.flatMap(c => [c, c.toLowerCase(), c.toUpperCase()])));
	const hits = await ProductionBucket.find({ $or: [{ _id: { $in: ids } }, { barcode: { $in: variants } }] })
		.select('_id barcode').lean() as any[];
	for (const c of cleaned) {
		const hit = hits.find(h => h._id === c.toUpperCase() || (h.barcode && String(h.barcode).toLowerCase() === c.toLowerCase()));
		if (hit) out.set(c, hit._id);
	}
	return out;
}

export interface ScanResolution {
	kind: 'bucket' | 'search';
	bucket?: any;
	cycle?: any | null;
	matches?: { bucketId: string; barcode: string | null; state: string; cycle: any | null }[];
}

/**
 * One label, no modes (§9.1): an exact bucket id or sticker resolves to that
 * bucket and its open cycle (if any); anything else becomes a short search.
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

// ── buckets: create + sticker ─────────────────────────────────────────────

async function assertStickerFree(code: string, exceptBucketId?: string): Promise<void> {
	if (/^BKT-\d+$/i.test(code)) throw new BucketError('That is an internal bucket id, not a sticker — scan the QR sticker.');
	const cart = await CartridgeRecord.findById(code).select('_id status').lean() as any;
	if (cart) throw new BucketError(`${code} is already cartridge ${cart._id} (status ${cart.status ?? 'unknown'}) — use an unused sticker.`, 409);
	const other = await ProductionBucket.findOne({ barcode: code, ...(exceptBucketId ? { _id: { $ne: exceptBucketId } } : {}) }).select('_id').lean() as any;
	if (other) throw new BucketError(`${code} is already the sticker on bucket ${other._id}.`, 409);
}

/**
 * New bucket = one QR sticker scanned (v2: one at a time, nothing else asked).
 * The bucket gets a permanent internal BKT- id so a damaged sticker can be
 * replaced later without the tub becoming a new bucket.
 */
export async function createBucket(input: { qr: string; user: Operator }): Promise<{ bucketId: string; barcode: string }> {
	await connectDB();
	const code = (input.qr ?? '').trim();
	if (!code) throw new BucketError('Scan the QR sticker for the new bucket.');
	await assertStickerFree(code);
	const id = await generateBarcode(BUCKET_PREFIX, 'bucket');
	try {
		await ProductionBucket.create({
			_id: id,
			barcode: code,
			state: 'available',
			cycleCount: 0,
			spotCheckPending: false,
			createdBy: { _id: input.user._id, username: input.user.username }
		});
	} catch (e: any) {
		if (e?.code === 11000) throw new BucketError(`${code} was just assigned to another bucket.`, 409);
		throw e;
	}
	await logTx({ bucketId: id, type: 'mint', reason: `sticker ${code}`, relatedId: code, operator: input.user });
	await audit('production_buckets', id, 'INSERT', input.user, { barcode: code, state: 'available' });
	return { bucketId: id, barcode: code };
}

/** Replace a damaged sticker. The BKT- id and all history stay put. */
export async function replaceBucketSticker(input: { bucketId: string; qr: string; user: Operator }): Promise<{ bucketId: string; barcode: string; previous: string | null }> {
	await connectDB();
	const bucketId = await resolveBucketId(input.bucketId);
	if (!bucketId) throw new BucketError(`"${(input.bucketId ?? '').trim()}" is not a known bucket.`, 404);
	const bucket = await ProductionBucket.findById(bucketId).lean() as any;
	if (bucket.state === 'retired') throw new BucketError(`Bucket ${bucketId} is retired.`);
	const code = (input.qr ?? '').trim();
	if (!code) throw new BucketError('Scan the new QR sticker.');
	if (bucket.barcode === code) throw new BucketError(`${code} is already on ${bucketId}.`);
	await assertStickerFree(code, bucketId);
	const previous: string | null = bucket.barcode ?? null;
	try {
		await ProductionBucket.updateOne({ _id: bucketId }, { $set: { barcode: code } });
	} catch (e: any) {
		if (e?.code === 11000) throw new BucketError(`${code} was just assigned to another bucket.`, 409);
		throw e;
	}
	await logTx({ bucketId, type: 'relabel', reason: previous ? `sticker replaced: ${previous} → ${code}` : `sticker assigned: ${code}`, relatedId: code, operator: input.user });
	await audit('production_buckets', bucketId, 'RELABEL', input.user, { barcode: code }, { barcode: previous });
	return { bucketId, barcode: code, previous };
}

// ── cycle lifecycle ───────────────────────────────────────────────────────

async function closeCycle(cycle: any, status: 'consumed' | 'scrapped', user: Operator, relatedId?: string): Promise<void> {
	const now = new Date();
	await BucketCycle.updateOne({ _id: cycle._id }, { $set: { status, closedAt: now, quantity: 0, cartridgeIds: [] } });
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
	shellLotId: string;       // PT-CT-104 ReceivingLot.lotId
	labelLotId: string;       // PT-CT-106 ReceivingLot.lotId
	emptyConfirmed?: boolean; // required when the bucket has spotCheckPending
	user: Operator;
}

/**
 * Open a pass at Raw with zero members. Shells are then scanned in one at a
 * time (scanCartIn). The shell and label lots are fixed here so every scan
 * debits against the same lots.
 */
export async function startCycle(input: StartCycleInput): Promise<any> {
	await connectDB();
	const bucketId = await resolveBucketId(input.bucketId);
	if (!bucketId) throw new BucketError(`"${(input.bucketId ?? '').trim()}" is not a known bucket — scan its QR sticker, or create it first.`, 404);

	const bucket = await ProductionBucket.findById(bucketId).lean() as any;
	if (bucket.state === 'retired') throw new BucketError(`Bucket ${bucketId} is retired.`);
	if (bucket.state === 'in_use') throw new BucketError(`Bucket ${bucketId} already holds an open pass.`, 409);
	if (bucket.state === 'quarantined') {
		throw new BucketError(`Bucket ${bucketId} has undispositioned contents (${bucket.residualNote ?? 'residual'}) — disposition them first.`, 409, 'QUARANTINED');
	}
	if (bucket.spotCheckPending && !input.emptyConfirmed) {
		throw new BucketError('Confirm the tub is empty before starting a new pass.', 409, 'SPOT_CHECK');
	}

	const shell = await validateReceivingLot(input.shellLotId, SHELL_PART);
	if (!shell.ok) throw new BucketError(`Shell lot: ${shell.reason}`);
	const label = await validateReceivingLot(input.labelLotId, LABEL_PART);
	if (!label.ok) throw new BucketError(`Label lot: ${label.reason}`);

	const now = new Date();
	const cycleNumber = (bucket.cycleCount ?? 0) + 1;
	const cycleId = generateId();
	try {
		await BucketCycle.create({
			_id: cycleId,
			bucketId,
			cycleNumber,
			stage: 'raw',
			cartridgeIds: [],
			quantity: 0,
			openedQty: 0,
			sourceLots: [
				{ partNumber: SHELL_PART, lotId: shell.lot.lotId, scannedAt: now },
				{ partNumber: LABEL_PART, lotId: label.lot.lotId, scannedAt: now }
			],
			status: 'open',
			...(bucket.spotCheckPending
				? { emptyConfirmedBy: { _id: input.user._id, username: input.user.username }, emptyConfirmedAt: now }
				: {}),
			openedBy: { _id: input.user._id, username: input.user.username },
			openedAt: now,
			stageEnteredAt: now
		});
	} catch (e: any) {
		if (e?.code === 11000) throw new BucketError(`Bucket ${bucketId} already holds an open pass.`, 409);
		throw e;
	}

	await ProductionBucket.updateOne(
		{ _id: bucketId },
		{ $set: { state: 'in_use', currentCycleId: cycleId, spotCheckPending: false }, $inc: { cycleCount: 1 } }
	);
	await logTx({ bucketId, cycleId, type: 'create', fromStage: null, toStage: 'raw', qtyBefore: 0, qtyAfter: 0, relatedId: shell.lot.lotId, operator: input.user });
	await audit('bucket_cycles', cycleId, 'INSERT', input.user, { bucketId, cycleNumber, shellLot: shell.lot.lotId, labelLot: label.lot.lotId, emptyConfirmed: !!bucket.spotCheckPending });
	return BucketCycle.findById(cycleId).lean();
}

export interface ScanCartInput {
	cycleId: string;
	barcode: string;
	user: Operator;
}

/**
 * The cartridge's birth. Only while the pass is at Raw. Refuses a code that
 * is already a cartridge or a bucket's sticker. Debits one shell + one label
 * against the pass's lots.
 */
export async function scanCartIn(input: ScanCartInput): Promise<{ cycle: any; barcode: string }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	if (cycle.stage !== 'raw') throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is at ${STAGE_LABELS[cycle.stage as BucketStage]} — carts can only be scanned in while a bucket is at Raw.`);
	const barcode = (input.barcode ?? '').trim();
	if (!barcode) throw new BucketError('Scan the cartridge QR.');
	if (/^BKT-\d+$/i.test(barcode)) throw new BucketError('That is a bucket id, not a cartridge sticker.');
	await assertNotBucketLabel(barcode);
	const existing = await CartridgeRecord.findById(barcode).select('_id status bucket').lean() as any;
	if (existing) {
		const where = existing.bucket?.bucketId ? ` (in bucket ${existing.bucket.bucketId})` : '';
		throw new BucketError(`${barcode} already exists as a cartridge with status "${existing.status ?? 'unknown'}"${where} — a sticker is born once.`, 409);
	}

	const now = new Date();
	const op = { _id: input.user._id, username: input.user.username };
	const shellLot = lotFor(cycle.sourceLots, SHELL_PART);
	const labelLot = lotFor(cycle.sourceLots, LABEL_PART);
	try {
		await CartridgeRecord.create({
			_id: barcode,
			status: 'raw',
			statusUpdatedOn: now.toISOString(),
			bucket: { bucketId: cycle.bucketId, cycleId: cycle._id, scannedInAt: now, scannedInBy: op },
			backing: {
				cartridgeBlankLot: shellLot ?? null,
				barcodeLabelLot: labelLot ?? null,
				bucketCycleId: cycle._id,
				bucketBarcode: cycle.bucketId
			}
		});
	} catch (e: any) {
		if (e?.code === 11000) throw new BucketError(`${barcode} was just scanned somewhere else.`, 409);
		throw e;
	}
	const before: number = cycle.quantity ?? 0;
	await BucketCycle.updateOne({ _id: cycle._id }, { $addToSet: { cartridgeIds: barcode }, $inc: { quantity: 1 } });

	const label = cycleLabel(cycle.bucketId, cycle.cycleNumber);
	await debit(SHELL_PART, shellLot, 1, cycle._id, input.user, `Scan-in ${barcode} into ${label}: 1x ${SHELL_PART} shell from lot ${shellLot ?? '(none)'}`);
	await debit(LABEL_PART, labelLot, 1, cycle._id, input.user, `Scan-in ${barcode} into ${label}: 1x ${LABEL_PART} label from lot ${labelLot ?? '(none)'}`);

	await logTx({ bucketId: cycle.bucketId, cycleId: cycle._id, type: 'scan_in', fromStage: 'raw', toStage: 'raw', qtyBefore: before, qtyAfter: before + 1, cartridgeIds: [barcode], operator: input.user });
	await audit('cartridge_records', barcode, 'INSERT', input.user, { status: 'raw', bucketId: cycle.bucketId, cycleId: cycle._id });
	return { cycle: await BucketCycle.findById(cycle._id).lean(), barcode };
}

/**
 * Undo a mis-scan while the pass is still at Raw: the cartridge record is
 * deleted (it was born seconds ago and has no history) and the shell + label
 * debits are retracted.
 */
export async function unscanCart(input: ScanCartInput): Promise<any> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	if (cycle.stage !== 'raw') throw new BucketError('Carts can only be un-scanned while the bucket is at Raw — after that, use Discard.');
	const barcode = (input.barcode ?? '').trim();
	if (!(cycle.cartridgeIds ?? []).includes(barcode)) throw new BucketError(`${barcode} is not in ${cycleLabel(cycle.bucketId, cycle.cycleNumber)}.`);
	const cart = await CartridgeRecord.findById(barcode).select('status bucket').lean() as any;
	if (!cart || cart.status !== 'raw' || cart.bucket?.cycleId !== cycle._id) throw new BucketError(`${barcode} is no longer a raw member of this pass.`);

	await CartridgeRecord.deleteOne({ _id: barcode });
	const before: number = cycle.quantity ?? 0;
	await BucketCycle.updateOne({ _id: cycle._id }, { $pull: { cartridgeIds: barcode }, $inc: { quantity: -1 } });

	const label = cycleLabel(cycle.bucketId, cycle.cycleNumber);
	for (const pn of [SHELL_PART, LABEL_PART]) {
		const partId = await resolvePartId(pn);
		await retract('consumption', partId, lotFor(cycle.sourceLots, pn) ?? null, 1, cycle._id, input.user, `Un-scan ${barcode} from ${label}: 1x ${pn} returned`);
	}
	await logTx({ bucketId: cycle.bucketId, cycleId: cycle._id, type: 'unscan', fromStage: 'raw', toStage: 'raw', qtyBefore: before, qtyAfter: Math.max(0, before - 1), cartridgeIds: [barcode], reason: 'mis-scan removed', operator: input.user });
	await audit('cartridge_records', barcode, 'DELETE', input.user, undefined, { status: 'raw', cycleId: cycle._id }, 'Operator removed mis-scanned cartridge while bucket at Raw');
	return BucketCycle.findById(cycle._id).lean();
}

export interface ScrapInput {
	cycleId: string;
	barcodes: string[];      // the discarded cartridges, scanned
	journal: string;
	user: Operator;
	relatedId?: string;      // LotRecord._id when scrapped during WI-01
	skipInventory?: boolean; // WI-01 confirm withdraws its own scrap
}

/**
 * Discard specific cartridges from an open pass: each becomes status
 * 'scrapped', leaves the membership list, is written to ManualCartridgeRemoval
 * (so it shows in Recent Checkouts), and — unless the caller withdraws
 * inventory itself — what the cart physically was at that stage is scrapped
 * from stock.
 */
export async function scrapCarts(input: ScrapInput): Promise<{ cycle: any; removalId: string; scrapped: string[] }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	const ids = cleanCodes(input.barcodes);
	if (ids.length === 0) throw new BucketError('Scan the cartridge(s) being discarded.');
	const members = new Set<string>(cycle.cartridgeIds ?? []);
	const notMembers = ids.filter(id => !members.has(id));
	if (notMembers.length) throw new BucketError(`Not in ${cycleLabel(cycle.bucketId, cycle.cycleNumber)}: ${notMembers.join(', ')}`);
	const journal = (input.journal ?? '').trim();
	if (!journal) throw new BucketError('A journal entry describing why these were discarded is required.');

	const now = new Date();
	const op = { _id: input.user._id, username: input.user.username };
	const stage = cycle.stage as BucketStage;
	await CartridgeRecord.updateMany(
		{ _id: { $in: ids } },
		{
			$set: { status: 'scrapped', statusUpdatedOn: now.toISOString(), priorStatus: stage },
			$push: { notes: { _id: generateId(), body: `Discarded from bucket ${cycleLabel(cycle.bucketId, cycle.cycleNumber)} at ${STAGE_LABELS[stage]}: ${journal}`, phase: 'bucket', author: op, createdAt: now } }
		}
	);
	const removalId = generateId();
	await ManualCartridgeRemoval.create({
		_id: removalId,
		cartridgeIds: ids,
		bucketCycleId: cycle._id,
		bucketId: cycle.bucketId,
		cartridgeCount: ids.length,
		reason: journal,
		journal,
		operator: op,
		removedAt: now
	});
	if (!input.skipInventory) {
		const label = cycleLabel(cycle.bucketId, cycle.cycleNumber);
		for (const pn of partsAtStage(stage)) {
			await debitScrap(pn, lotFor(cycle.sourceLots, pn), ids.length, cycle._id, input.user, journal, `Bucket ${label}: ${ids.length}x ${pn} discarded at ${STAGE_LABELS[stage]} — ${journal}`);
		}
	}

	const before: number = cycle.quantity ?? 0;
	const after = Math.max(0, before - ids.length);
	await BucketCycle.updateOne({ _id: cycle._id }, { $pull: { cartridgeIds: { $in: ids } }, $set: { quantity: after } });
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'scrap',
		fromStage: stage, toStage: stage, qtyBefore: before, qtyAfter: after,
		reason: journal, journal, relatedId: input.relatedId ?? removalId, cartridgeIds: ids, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'SCRAP', input.user, { scrapped: ids, quantity: after, removalId }, { quantity: before }, journal);
	if (after === 0) await closeCycle({ ...cycle, quantity: 0 }, 'scrapped', input.user, removalId);
	return { cycle: await BucketCycle.findById(cycle._id).lean(), removalId, scrapped: ids };
}

export interface AdvanceCycleInput {
	cycleId: string;
	user: Operator;
	thermosealLotId?: string;   // PT-CT-112 lot to pull the NEXT roll from, if one is opened (optional; FIFO default)
	discardedIds?: string[];    // carts binned at this step (scanned)
	discardJournal?: string;    // required when discardedIds is non-empty
}

/**
 * Move the whole bucket one stage forward. Discards are recorded first (so a
 * discard is never written for a move that then fails, and the thermoseal
 * debit covers only carts that move), then every remaining member's status
 * follows the bucket. raw → unpressed takes members × 3.75 cm of thermoseal
 * off the open roll (thermoseal-service); the roll pull, if one happens, is
 * where PT-CT-112 inventory actually moves.
 */
export async function advanceCycle(input: AdvanceCycleInput): Promise<{ cycle: any | null; discarded: number; closed: boolean; thermoseal: ConsumeResult | null }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	const from = cycle.stage as BucketStage;
	const to = nextStage(from);
	if (!to) throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is already at Pressed — WI-01 draws it into the oven from here.`);
	if ((cycle.cartridgeIds ?? []).length === 0) throw new BucketError('Scan at least one cart into the bucket before advancing it.');

	const discardIds = cleanCodes(input.discardedIds);
	const journal = (input.discardJournal ?? '').trim();
	if (discardIds.length > 0 && !journal) throw new BucketError('Say why the carts were discarded.');
	const members = new Set<string>(cycle.cartridgeIds ?? []);
	const notMembers = discardIds.filter(id => !members.has(id));
	if (notMembers.length) throw new BucketError(`Not in this bucket: ${notMembers.join(', ')}`);

	let thermosealLot: string | undefined;
	if (to === 'unpressed' && (input.thermosealLotId ?? '').trim()) {
		const check = await validateReceivingLot(input.thermosealLotId ?? '', THERMOSEAL_PART);
		if (!check.ok) throw new BucketError(`Thermoseal lot: ${check.reason}`);
		thermosealLot = check.lot.lotId;
	}

	if (discardIds.length > 0) {
		await scrapCarts({ cycleId: cycle._id, barcodes: discardIds, journal: `Discarded at ${STAGE_LABELS[from]} → ${STAGE_LABELS[to]}: ${journal}`, user: input.user });
		if (discardIds.length === members.size) {
			return { cycle: await BucketCycle.findById(cycle._id).lean(), discarded: discardIds.length, closed: true, thermoseal: null };
		}
	}

	const fresh = await BucketCycle.findById(cycle._id).lean() as any;
	const moving: string[] = fresh.cartridgeIds ?? [];
	const now = new Date();
	const set: Record<string, unknown> = { stage: to, stageEnteredAt: now };
	if (from === 'raw') set.openedQty = moving.length; // the pass's "opened with" count is fixed when it leaves Raw
	const push: Record<string, unknown> = {};
	let thermoseal: ConsumeResult | null = null;
	if (to === 'unpressed') {
		try {
			thermoseal = await consumeThermoseal({ cartridges: moving.length, user: input.user, cycleId: cycle._id, lotId: thermosealLot });
		} catch (e) {
			if (e instanceof ThermosealError) throw new BucketError(`Thermoseal: ${e.message}`, e.status);
			throw e;
		}
		set.thermoseal = { cm: thermoseal.cm, cartridges: moving.length, segments: thermoseal.segments, consumedAt: now };
		if (thermosealLot) push.sourceLots = { partNumber: THERMOSEAL_PART, lotId: thermosealLot, scannedAt: now };
	}
	await BucketCycle.updateOne({ _id: cycle._id }, { $set: set, ...(Object.keys(push).length ? { $push: push } : {}) });
	await CartridgeRecord.updateMany(
		{ _id: { $in: moving } },
		{ $set: { status: to, statusUpdatedOn: now.toISOString(), priorStatus: from, ...(thermosealLot ? { 'backing.thermosealLot': thermosealLot } : {}) } }
	);
	const tsNote = thermoseal
		? `thermoseal ${thermoseal.cm} cm (${moving.length} × 3.75 cm) from roll${thermoseal.segments.length === 1 ? '' : 's'} ${thermoseal.segments.map(s => s.rollId.slice(0, 8)).join(', ')}${thermoseal.rollsOpened.length ? ` — ${thermoseal.rollsOpened.length} new roll${thermoseal.rollsOpened.length === 1 ? '' : 's'} pulled from inventory` : ''}`
		: undefined;
	await logTx({ bucketId: cycle.bucketId, cycleId: cycle._id, type: 'advance', fromStage: from, toStage: to, qtyBefore: moving.length, qtyAfter: moving.length, relatedId: thermoseal?.segments[0]?.rollId ?? thermosealLot, reason: tsNote, cartridgeIds: moving, operator: input.user });
	await audit('bucket_cycles', cycle._id, 'ADVANCE', input.user, { from, to, members: moving.length, thermosealLot, thermoseal: thermoseal ? { cm: thermoseal.cm, segments: thermoseal.segments, rollsOpened: thermoseal.rollsOpened } : undefined });
	return { cycle: await BucketCycle.findById(cycle._id).lean(), discarded: discardIds.length, closed: false, thermoseal };
}

export interface ConsumeInput {
	cycleId: string;
	barcodes: string[];   // cartridges WI-01 scanned into the oven
	lotRecordId: string;
	user: Operator;
}

/**
 * WI-01 handoff: the scanned cartridges leave the bucket. The caller (WI-01)
 * sets their status to 'backing' and stamps the lot; this only maintains the
 * membership list and closes the pass when the last member leaves. Nothing is
 * debited — every part was consumed upstream.
 */
export async function consumeCarts(input: ConsumeInput): Promise<{ qtyBefore: number; qtyAfter: number; consumed: string[] }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	if (cycle.stage !== 'pressed') {
		throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is at ${STAGE_LABELS[cycle.stage as BucketStage]} — only Pressed buckets go into the oven.`);
	}
	const ids = cleanCodes(input.barcodes);
	const members = new Set<string>(cycle.cartridgeIds ?? []);
	const notMembers = ids.filter(id => !members.has(id));
	if (notMembers.length) throw new BucketError(`Not in ${cycleLabel(cycle.bucketId, cycle.cycleNumber)}: ${notMembers.join(', ')}`);
	if (ids.length === 0) return { qtyBefore: cycle.quantity ?? 0, qtyAfter: cycle.quantity ?? 0, consumed: [] };

	const before: number = cycle.quantity ?? 0;
	const after = Math.max(0, before - ids.length);
	await BucketCycle.updateOne({ _id: cycle._id }, { $pull: { cartridgeIds: { $in: ids } }, $set: { quantity: after } });
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'consume',
		fromStage: 'pressed', toStage: 'pressed', qtyBefore: before, qtyAfter: after,
		relatedId: input.lotRecordId, cartridgeIds: ids, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'CONSUME', input.user, { consumed: ids.length, quantity: after, lotRecordId: input.lotRecordId }, { quantity: before });
	if (after === 0) await closeCycle({ ...cycle, quantity: 0 }, 'consumed', input.user, input.lotRecordId);
	return { qtyBefore: before, qtyAfter: after, consumed: ids };
}

// ── residual flow (§7, v2: scan the leftover carts) ───────────────────────

export interface ResidualInput {
	bucketId: string;
	barcodes: string[];           // the leftover cartridges found in the tub, scanned
	disposition: ResidualDisposition;
	destinationBucketId?: string; // merge
	journal?: string;             // required for scrap; optional note for defer
	user: Operator;
}

/**
 * Leftovers found in a tub. Each scanned code must be a known cartridge that
 * is still pre-oven (raw / unpressed / pressed) and not a member of any open
 * pass — i.e. it got left behind. Merge moves them into another open bucket
 * (they take that bucket's stage); scrap discards them; defer quarantines the
 * tub with the list in the note. Everything is validated before any write.
 */
export async function reportResidual(input: ResidualInput): Promise<{ bucket: any; prevCycle: any | null }> {
	await connectDB();
	const ids = cleanCodes(input.barcodes);
	if (ids.length === 0) throw new BucketError('Scan the leftover cartridge(s).');
	const bucketId = await resolveBucketId(input.bucketId);
	if (!bucketId) throw new BucketError(`"${(input.bucketId ?? '').trim()}" is not a known bucket.`, 404);
	const bucket = await ProductionBucket.findById(bucketId).lean() as any;
	if (bucket.state === 'in_use') throw new BucketError(`Bucket ${bucketId} has an open pass — un-scan or discard from that pass instead of reporting a residual.`);
	if (bucket.state === 'retired') throw new BucketError(`Bucket ${bucketId} is retired.`);

	const carts = await CartridgeRecord.find({ _id: { $in: ids } }).select('_id status bucket backing').lean() as any[];
	const byId = new Map(carts.map(c => [c._id, c]));
	const unknown = ids.filter(id => !byId.has(id));
	if (unknown.length) throw new BucketError(`Not known cartridges: ${unknown.join(', ')} — leftovers must have been scanned into a bucket before.`);
	const tooFar = carts.filter(c => !isBucketStage(c.status));
	if (tooFar.length) throw new BucketError(`Already past the buckets: ${tooFar.map(c => `${c._id} (${c.status})`).join(', ')}`);
	const stillMembers = await BucketCycle.find({ status: 'open', cartridgeIds: { $in: ids } }).select('bucketId cycleNumber cartridgeIds').lean() as any[];
	if (stillMembers.length) {
		const where = stillMembers.map(c => `${cycleLabel(c.bucketId, c.cycleNumber)}: ${ids.filter(i => c.cartridgeIds.includes(i)).join(', ')}`).join('; ');
		throw new BucketError(`Still members of an open pass — ${where}. Discard or un-scan them there.`);
	}

	const prevCycle = await BucketCycle.findOne({ bucketId }).sort({ cycleNumber: -1 }).lean() as any;
	const now = new Date();
	const by = { _id: input.user._id, username: input.user.username };
	const journal = (input.journal ?? '').trim();
	const qty = ids.length;
	const found: Record<string, unknown> = { qty, cartridgeIds: ids, disposition: input.disposition, at: now, by };
	let relatedId: string | undefined;

	if (input.disposition === 'merge') {
		const destRaw = (input.destinationBucketId ?? '').trim();
		if (!destRaw) throw new BucketError('Scan the destination bucket.');
		const destId = await resolveBucketId(destRaw);
		if (!destId) throw new BucketError(`"${destRaw}" is not a known bucket.`, 404);
		if (destId === bucketId) throw new BucketError('Destination must be a different bucket.');
		const dest = await getOpenCycle(destId);
		if (!dest) throw new BucketError(`Bucket ${destId} has no open pass to merge into.`);
		const destStage = dest.stage as BucketStage;
		await BucketCycle.updateOne({ _id: dest._id }, { $addToSet: { cartridgeIds: { $each: ids } }, $set: { quantity: (dest.quantity ?? 0) + qty } });
		await CartridgeRecord.updateMany(
			{ _id: { $in: ids } },
			{ $set: { status: destStage, statusUpdatedOn: now.toISOString(), 'bucket.bucketId': destId, 'bucket.cycleId': dest._id, 'backing.bucketCycleId': dest._id, 'backing.bucketBarcode': destId } }
		);
		await logTx({ bucketId: destId, cycleId: dest._id, type: 'merge_in', fromStage: destStage, toStage: destStage, qtyBefore: dest.quantity ?? 0, qtyAfter: (dest.quantity ?? 0) + qty, reason: `residual from ${bucketId}${prevCycle ? ` #${prevCycle.cycleNumber}` : ''}`, relatedId: prevCycle?._id ?? bucketId, cartridgeIds: ids, operator: input.user });
		await logTx({ bucketId, cycleId: prevCycle?._id ?? null, type: 'merge_out', fromStage: destStage, toStage: destStage, qtyBefore: qty, qtyAfter: 0, reason: `residual merged into ${cycleLabel(destId, dest.cycleNumber)}`, relatedId: dest._id, cartridgeIds: ids, operator: input.user });
		found.destinationCycleId = dest._id;
		found.stage = destStage;
		relatedId = dest._id;
		await audit('bucket_cycles', dest._id, 'MERGE_IN', input.user, { from: bucketId, cartridgeIds: ids, quantity: (dest.quantity ?? 0) + qty }, { quantity: dest.quantity });
	} else if (input.disposition === 'scrap') {
		if (!journal) throw new BucketError('A journal entry describing why these were scrapped is required.');
		const removalId = generateId();
		await CartridgeRecord.updateMany(
			{ _id: { $in: ids } },
			{ $set: { status: 'scrapped', statusUpdatedOn: now.toISOString() }, $push: { notes: { _id: generateId(), body: `Residual found in bucket ${bucketId}, scrapped: ${journal}`, phase: 'bucket', author: by, createdAt: now } } }
		);
		await ManualCartridgeRemoval.create({ _id: removalId, cartridgeIds: ids, bucketCycleId: prevCycle?._id, bucketId, cartridgeCount: qty, reason: journal, journal, operator: by, removedAt: now });
		// Each leftover is scrapped as whatever it was: group by the status it had.
		const byStage = new Map<BucketStage, number>();
		for (const c of carts) byStage.set(c.status as BucketStage, (byStage.get(c.status as BucketStage) ?? 0) + 1);
		for (const [stage, n] of byStage) {
			for (const pn of partsAtStage(stage)) {
				await debitScrap(pn, lotFor(prevCycle?.sourceLots, pn), n, prevCycle?._id ?? null, input.user, `residual: ${journal}`, `Bucket ${bucketId} residual: ${n}x ${pn} at ${STAGE_LABELS[stage]} scrapped — ${journal}`);
			}
		}
		await logTx({ bucketId, cycleId: prevCycle?._id ?? null, type: 'scrap', qtyBefore: qty, qtyAfter: 0, reason: journal, journal, relatedId: removalId, cartridgeIds: ids, operator: input.user });
		found.removalId = removalId;
		relatedId = removalId;
	} else if (input.disposition === 'defer') {
		const note = `${qty} cart${qty === 1 ? '' : 's'} (${ids.slice(0, 4).map(i => i.slice(0, 8)).join(', ')}${ids.length > 4 ? '…' : ''})${journal ? ` — ${journal}` : ''}`;
		await ProductionBucket.updateOne({ _id: bucketId }, { $set: { state: 'quarantined', residualNote: note, spotCheckPending: false } });
		await logTx({ bucketId, cycleId: prevCycle?._id ?? null, type: 'quarantine', qtyBefore: qty, qtyAfter: qty, reason: note, cartridgeIds: ids, operator: input.user });
	} else {
		throw new BucketError('Unknown disposition.');
	}

	if (input.disposition !== 'defer') {
		await ProductionBucket.updateOne({ _id: bucketId }, { $set: { state: 'available', spotCheckPending: false }, $unset: { residualNote: 1 } });
	}
	// Never rewrite the closed cycle's quantity (§7.1) — append what was found.
	if (prevCycle) {
		await BucketCycle.updateOne(
			{ _id: prevCycle._id },
			{ $set: { closedWithResidual: true }, $push: { residualFound: found, discrepancies: { type: 'shortfall', qty, relatedId, at: now, note: `${qty} cart(s) found in tub after close — ${input.disposition}` } } }
		);
		await audit('bucket_cycles', prevCycle._id, 'RESIDUAL', input.user, found);
	}
	await audit('production_buckets', bucketId, 'RESIDUAL', input.user, { cartridgeIds: ids, disposition: input.disposition, relatedId });
	return { bucket: await ProductionBucket.findById(bucketId).lean(), prevCycle: prevCycle ? await BucketCycle.findById(prevCycle._id).lean() : null };
}

export async function retireBucket(bucketId: string, reason: string, user: Operator): Promise<void> {
	await connectDB();
	const id = await resolveBucketId(bucketId);
	if (!id) throw new BucketError(`"${(bucketId ?? '').trim()}" is not a known bucket.`, 404);
	const bucket = await ProductionBucket.findById(id).lean() as any;
	if (bucket.state === 'in_use') throw new BucketError('Empty or discard the open pass before retiring this bucket.');
	if (bucket.state === 'retired') throw new BucketError('Already retired.');
	const why = (reason ?? '').trim();
	if (!why) throw new BucketError('A reason is required to retire a bucket.');
	await ProductionBucket.updateOne({ _id: id }, { $set: { state: 'retired', retiredAt: new Date(), retiredReason: why } });
	await logTx({ bucketId: id, type: 'retire', reason: why, operator: user });
	await audit('production_buckets', id, 'RETIRE', user, { state: 'retired' }, { state: bucket.state }, why);
}

// ── void a pass (§12.2) ───────────────────────────────────────────────────

export interface VoidCycleInput { cycleId: string; reason: string; user: Operator }
export interface VoidCycleResult {
	cycleId: string; bucketId: string; cycleNumber: number;
	restored: { partNumber: string | null; lotId: string | null; quantity: number }[];
	thermosealCreditedCm: number;   // length given back to its roll(s); an opened roll is never returned to stock
	cartridgesVoided: number; removalsMarked: number;
}

/**
 * Void a pass that never really happened — test data, or a pass opened
 * against the wrong lot — and give back exactly what it took from inventory.
 * Refused if any of its cartridges went on into the oven (they were really
 * used). Its cartridges become 'voided'; nothing is deleted.
 */
export async function voidCycle(input: VoidCycleInput): Promise<VoidCycleResult> {
	await connectDB();
	const reason = (input.reason ?? '').trim();
	if (!reason) throw new BucketError('Say why this pass is being voided.');
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle) throw new BucketError('Pass not found.', 404);
	if (cycle.status === 'voided') throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is already voided.`, 409);

	const born = await CartridgeRecord.find({ 'bucket.cycleId': cycle._id }).select('_id status').lean() as any[];
	const wentOn = born.filter(c => !isBucketStage(c.status) && c.status !== 'scrapped' && c.status !== 'voided');
	if (wentOn.length > 0) {
		throw new BucketError(`${wentOn.length} cartridge${wentOn.length === 1 ? '' : 's'} from ${cycleLabel(cycle.bucketId, cycle.cycleNumber)} went on past the buckets (e.g. ${wentOn[0]._id} is ${wentOn[0].status}) — that material was really used, so this pass cannot be voided.`, 409, 'SERIALIZED');
	}

	const now = new Date();
	const by = { _id: input.user._id, username: input.user.username };
	const claimed = await BucketCycle.findOneAndUpdate(
		{ _id: cycle._id, status: { $ne: 'voided' } },
		{ $set: { status: 'voided', statusBeforeVoid: cycle.status, voidedAt: now, voidedBy: by, voidReason: reason, closedAt: cycle.closedAt ?? now, cartridgeIds: [], quantity: 0 } }
	).lean();
	if (!claimed) throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is already voided.`, 409);

	const debits = await InventoryTransaction.find({ manufacturingRunId: cycle._id, transactionType: { $in: ['consumption', 'scrap'] } })
		.select('transactionType partDefinitionId lotId quantity').lean() as any[];
	const groups = new Map<string, { type: 'consumption' | 'scrap'; partDefinitionId: string | null; lotId: string | null; net: number }>();
	for (const d of debits) {
		const type = d.transactionType === 'scrap' ? 'scrap' : 'consumption';
		const key = `${type}|${d.partDefinitionId ?? ''}|${d.lotId ?? ''}`;
		const g = groups.get(key) ?? { type, partDefinitionId: d.partDefinitionId ?? null, lotId: d.lotId ?? null, net: 0 };
		g.net += Number(d.quantity ?? 0);
		groups.set(key, g);
	}
	const label = cycleLabel(cycle.bucketId, cycle.cycleNumber);
	const restored: VoidCycleResult['restored'] = [];
	for (const g of groups.values()) {
		if (!(g.net > 0)) continue;
		let partNumber: string | null = null;
		if (g.partDefinitionId) {
			const part = await PartDefinition.findById(g.partDefinitionId).select('partNumber').lean() as any;
			partNumber = part?.partNumber ?? null;
		}
		await retract(g.type, g.partDefinitionId, g.lotId, g.net, cycle._id, input.user, `VOID ${label}: returned ${g.net}x ${partNumber ?? 'part'}${g.lotId ? ` to lot ${g.lotId}` : ''}${g.type === 'scrap' ? ' (discard reversed)' : ''} — ${reason}`);
		restored.push({ partNumber, lotId: g.lotId, quantity: g.net });
	}

	// Thermoseal was taken by length, not as a debit on this pass — credit the
	// segments back to their rolls. The roll pull itself (−1 PT-CT-112) stays:
	// that roll is physically open on the press.
	const thermosealCreditedCm = cycle.thermoseal?.segments?.length
		? await creditThermoseal({ segments: cycle.thermoseal.segments, user: input.user, reason: `VOID ${label}: ${reason}` })
		: 0;

	const voidable = born.map(c => c._id);
	if (voidable.length) {
		await CartridgeRecord.updateMany(
			{ _id: { $in: voidable } },
			{ $set: { status: 'voided', voidedAt: now, voidReason: `Bucket pass ${label} voided: ${reason}`, statusUpdatedOn: now.toISOString() } }
		);
	}
	if (cycle.status === 'open') {
		await ProductionBucket.updateOne({ _id: cycle.bucketId, currentCycleId: cycle._id }, { $set: { state: 'available', currentCycleId: null, spotCheckPending: true } });
	}
	const marked = await ManualCartridgeRemoval.updateMany({ bucketCycleId: cycle._id, voidedAt: { $exists: false } }, { $set: { voidedAt: now, voidReason: reason } });

	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'void', fromStage: cycle.stage, toStage: cycle.stage, qtyBefore: cycle.quantity ?? 0, qtyAfter: 0,
		reason: `${reason} — returned ${restored.map(r => `${r.quantity}x ${r.partNumber ?? 'part'}`).join(', ') || 'nothing (no debits found)'}${thermosealCreditedCm > 0 ? `; ${thermosealCreditedCm} cm thermoseal credited back to its roll` : ''}; ${voidable.length} cartridge(s) voided`,
		cartridgeIds: voidable, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'VOID', input.user, { status: 'voided', restored, cartridgesVoided: voidable.length, removalsMarked: marked.modifiedCount ?? 0 }, { status: cycle.status, quantity: cycle.quantity }, reason);
	return { cycleId: cycle._id, bucketId: cycle.bucketId, cycleNumber: cycle.cycleNumber, restored, thermosealCreditedCm, cartridgesVoided: voidable.length, removalsMarked: marked.modifiedCount ?? 0 };
}

// ── read models ───────────────────────────────────────────────────────────

export interface StageCounts {
	stages: Record<BucketStage, { buckets: number; cartridges: number }>;
	inOven: number;       // cartridges at 'backing' — the stage after the buckets
	available: number;
	inUse: number;
	quarantined: number;
	retired: number;
}

export async function stageCounts(): Promise<StageCounts> {
	await connectDB();
	const [cycleAgg, bucketAgg, inOven] = await Promise.all([
		BucketCycle.aggregate([{ $match: { status: 'open' } }, { $group: { _id: '$stage', buckets: { $sum: 1 }, cartridges: { $sum: '$quantity' } } }]) as any as Promise<any[]>,
		ProductionBucket.aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }]) as any as Promise<any[]>,
		CartridgeRecord.countDocuments({ status: IN_OVEN_STATUS })
	]);
	const stages = Object.fromEntries(BUCKET_STAGES.map(s => [s, { buckets: 0, cartridges: 0 }])) as StageCounts['stages'];
	for (const row of cycleAgg) {
		const stage: unknown = row._id;
		if (isBucketStage(stage)) stages[stage] = { buckets: row.buckets ?? 0, cartridges: row.cartridges ?? 0 };
	}
	const byState = new Map(bucketAgg.map(r => [r._id, r.n ?? 0]));
	return {
		stages, inOven,
		available: byState.get('available') ?? 0,
		inUse: byState.get('in_use') ?? 0,
		quarantined: byState.get('quarantined') ?? 0,
		retired: byState.get('retired') ?? 0
	};
}

export interface BoardCycle {
	cycleId: string;
	bucketId: string;
	barcode: string | null;
	cycleNumber: number;
	stage: BucketStage;
	quantity: number;
	openedQty: number;
	cartridgeIds: string[];
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
	lastStage: BucketStage | null;
}

export async function boardData(): Promise<{ cycles: BoardCycle[]; available: BoardBucket[]; quarantined: BoardBucket[] }> {
	await connectDB();
	const [cycles, buckets, inUse] = await Promise.all([
		BucketCycle.find({ status: 'open' }).sort({ stageEnteredAt: 1 }).lean() as any as Promise<any[]>,
		ProductionBucket.find({ state: { $in: ['available', 'quarantined'] } }).sort({ _id: 1 }).lean() as any as Promise<any[]>,
		ProductionBucket.find({ state: 'in_use' }).select('_id barcode').lean() as any as Promise<any[]>
	]);
	const barcodeByBucket = new Map<string, string | null>(inUse.map(b => [b._id, b.barcode ?? null]));
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
		bucketId: b._id, barcode: b.barcode ?? null, state: b.state, cycleCount: b.cycleCount ?? 0,
		spotCheckPending: !!b.spotCheckPending, residualNote: b.residualNote ?? null, lastStage: lastStageByBucket.get(b._id) ?? null
	});
	return {
		cycles: cycles.filter(c => isBucketStage(c.stage)).map(c => ({
			cycleId: c._id, bucketId: c.bucketId, barcode: barcodeByBucket.get(c.bucketId) ?? null, cycleNumber: c.cycleNumber,
			stage: c.stage, quantity: c.quantity ?? 0, openedQty: c.openedQty ?? 0,
			cartridgeIds: c.cartridgeIds ?? [],
			stageEnteredAt: c.stageEnteredAt ? new Date(c.stageEnteredAt).toISOString() : null,
			openedAt: c.openedAt ? new Date(c.openedAt).toISOString() : null,
			openedBy: c.openedBy?.username ?? null,
			sourceLots: (c.sourceLots ?? []).map((l: any) => ({ partNumber: l.partNumber, lotId: l.lotId }))
		})),
		available: buckets.filter(b => b.state === 'available').map(toBucket),
		quarantined: buckets.filter(b => b.state === 'quarantined').map(toBucket)
	};
}

export interface ChangeLogRow {
	id: string; at: string | null; bucketId: string; cycleNumber: number | null; cycleVoided: boolean;
	type: string; fromStage: string | null; toStage: string | null;
	qtyBefore: number; qtyAfter: number; qtyDelta: number;
	reason: string | null; journal: string | null; relatedId: string | null; cartridgeIds: string[]; operator: string | null;
}

export async function changeLog(limit = 150): Promise<ChangeLogRow[]> {
	await connectDB();
	const tx = await BucketTransaction.find({}).sort({ createdAt: -1 }).limit(limit).lean() as any[];
	const cycleIds = Array.from(new Set(tx.map(t => t.cycleId).filter(Boolean)));
	const cycles = cycleIds.length ? await BucketCycle.find({ _id: { $in: cycleIds } }).select('_id cycleNumber status').lean() as any[] : [];
	const numByCycle = new Map<string, number>(cycles.map(c => [c._id, c.cycleNumber]));
	const voided = new Set<string>(cycles.filter(c => c.status === 'voided').map(c => c._id));
	return tx.map(t => ({
		id: t._id, at: t.createdAt ? new Date(t.createdAt).toISOString() : null, bucketId: t.bucketId,
		cycleNumber: t.cycleId ? (numByCycle.get(t.cycleId) ?? null) : null, cycleVoided: !!t.cycleId && voided.has(t.cycleId),
		type: t.type, fromStage: t.fromStage ?? null, toStage: t.toStage ?? null,
		qtyBefore: t.qtyBefore ?? 0, qtyAfter: t.qtyAfter ?? 0, qtyDelta: t.qtyDelta ?? 0,
		reason: t.reason ?? null, journal: t.journal ?? null, relatedId: t.relatedId ?? null,
		cartridgeIds: t.cartridgeIds ?? [], operator: t.operator?.username ?? null
	}));
}

export interface RegistryRow {
	bucketId: string; barcode: string | null; state: string; cycleCount: number;
	spotCheckPending: boolean; residualNote: string | null; retiredAt: string | null; retiredReason: string | null;
	createdAt: string | null; createdBy: string | null;
	current: { cycleNumber: number; stage: BucketStage; quantity: number } | null;
	lastActivityAt: string | null;
}

export async function bucketRegistry(): Promise<RegistryRow[]> {
	await connectDB();
	const [buckets, openCycles, lastTx] = await Promise.all([
		ProductionBucket.find({}).sort({ _id: 1 }).lean() as any as Promise<any[]>,
		BucketCycle.find({ status: 'open' }).select('bucketId cycleNumber stage quantity').lean() as any as Promise<any[]>,
		BucketTransaction.aggregate([{ $group: { _id: '$bucketId', last: { $max: '$createdAt' } } }]) as any as Promise<any[]>
	]);
	const cycleByBucket = new Map(openCycles.map(c => [c.bucketId, c]));
	const lastByBucket = new Map(lastTx.map(t => [t._id, t.last]));
	const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
	return buckets.map(b => {
		const c = cycleByBucket.get(b._id);
		return {
			bucketId: b._id, barcode: b.barcode ?? null, state: b.state ?? 'available', cycleCount: b.cycleCount ?? 0,
			spotCheckPending: !!b.spotCheckPending, residualNote: b.residualNote ?? null,
			retiredAt: iso(b.retiredAt), retiredReason: b.retiredReason ?? null, createdAt: iso(b.createdAt), createdBy: b.createdBy?.username ?? null,
			current: c && isBucketStage(c.stage) ? { cycleNumber: c.cycleNumber, stage: c.stage, quantity: c.quantity ?? 0 } : null,
			lastActivityAt: iso(lastByBucket.get(b._id))
		};
	});
}

/** Full history for one tub: every cycle it has held, plus the ledger. */
export async function bucketHistory(bucketId: string): Promise<{ bucket: any; cycles: any[]; transactions: any[]; removals: any[] } | null> {
	await connectDB();
	const id = await resolveBucketId(bucketId);
	if (!id) return null;
	const bucket = await ProductionBucket.findById(id).lean() as any;
	const [cycles, transactions, removals] = await Promise.all([
		BucketCycle.find({ bucketId: id }).sort({ cycleNumber: -1 }).lean(),
		BucketTransaction.find({ bucketId: id }).sort({ createdAt: -1 }).limit(500).lean(),
		ManualCartridgeRemoval.find({ bucketId: id }).sort({ removedAt: -1 }).lean()
	]);
	return { bucket, cycles, transactions, removals };
}
