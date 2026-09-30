/**
 * bucket-service.ts — every ProductionBucket / BucketCycle transition (v2).
 *
 * This file is load-bearing (BUCKET-SYSTEM_PLAN.md §10): the bucket board,
 * the residual flow and WI-01 all go through these functions so there is
 * exactly one code path per transition. Do not duplicate transition logic
 * into route actions.
 *
 * v2 model (user decision 2026-09-23):
 *   - The FIRST step is putting a QR sticker on each shell and scanning it
 *     into a bucket. That scan is the cartridge's birth: a CartridgeRecord is
 *     created at status 'barcoded'. A bucket pass is therefore a MEMBERSHIP LIST of
 *     cartridge ids, not a count.
 *   - Stages: barcoded → unpressed → pressed → backing, all inside the bucket.
 *     'backing' ("Backed") is a storage stage: the tub sits on the shelf until
 *     the operator clicks "Move to oven" — that frees every cart from the bucket
 *     and returns the tub to Available, nothing else. Carts keep status
 *     'backing' until wax filling scans them in (pressed → backed → wax filled);
 *     the board lists the freed ones under "In oven" inside the Backed column
 *     (2026-09-25; the WI-01 "Cartridge Back" page and its LotRecord session
 *     were removed). No oven equipment, no oven entry time, no cure-time gate
 *     anywhere — oven tracking is disabled, not modelled, and may come back.
 *   - Advancing a bucket advances every member's status. Discards, residuals
 *     and wax-fill draws are all "scan the cart" — the system knows exactly
 *     which cartridges exist.
 *
 * Inventory (the scan-in is the truth):
 *   - scan a cart into a bucket  → −1 PT-CT-104 (shell) and −1 PT-CT-106 (label)
 *   - barcoded → unpressed            → thermoseal by LENGTH: members × 3.75 cm off the open
 *                                  roll; a roll pull (−1 THERMOSEAL_PART roll) only when one
 *                                  runs out — the ONLY place thermoseal inventory moves
 *   - discard / residual scrap   → scrap of what the cart physically is at that
 *                                  stage (shell + label; thermoseal length is not returned)
 *   - wax-fill draw (deck load)  → nothing; everything was debited upstream
 *   - un-scan a mis-scanned barcoded cart → the shell + label debits are retracted
 */
import { connectDB } from '$lib/server/db/connection';
import {
	ProductionBucket, BucketCycle, BucketTransaction, AuditLog,
	ReceivingLot, ManualCartridgeRemoval, CartridgeRecord,
	InventoryTransaction, PartDefinition
} from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { recordTransaction, resolvePartId } from './inventory-transaction';
import { splitMergedBarcodes, hardDeleteUnfinalizedCartridges } from './cartridge-hard-delete';
import { generateBarcode } from './barcode-generator';
import { consumeThermoseal, creditThermoseal, ThermosealError, THERMOSEAL_PART, type ConsumeResult } from './thermoseal-service';

export const BUCKET_STAGES = ['barcoded', 'unpressed', 'pressed', 'backing'] as const;
export type BucketStage = (typeof BUCKET_STAGES)[number];

export const STAGE_LABELS: Record<BucketStage, string> = {
	barcoded: 'Barcoded',
	unpressed: 'Unpressed',
	pressed: 'Pressed',
	backing: 'Backed'
};

/**
 * The last bucket stage. Cart status 'backing' is what wax filling's deck load
 * accepts, so the bucket stage uses the same key and the cart mirrors it like
 * every other stage. Every cart at 'backing' counts as Backed, in a bucket or
 * not. "Move to oven" (moveToOven) is where carts leave the bucket system:
 * the pass closes, the tub returns to Available, and the carts — untouched,
 * still 'backing' — are "in oven" (inOvenCarts) until wax filling scans them.
 */
export const BACKED_STAGE: BucketStage = 'backing';
export const BACKED_STATUS = 'backing';
export const BACKED_LABEL = STAGE_LABELS.backing;

export const BUCKET_PREFIX = 'BKT';
export const SHELL_PART = 'PT-CT-104';
export const LABEL_PART = 'PT-CT-106';
// The thermoseal roll part is owned by thermoseal-service (one part, counted in rolls).
export { THERMOSEAL_PART };

export type Operator = { _id: string; username: string };
export type ResidualDisposition = 'merge' | 'scrap'; // 'defer' (quarantine) removed 2026-09-23

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
	type: 'mint' | 'relabel' | 'create' | 'scan_in' | 'unscan' | 'advance' | 'scrap' | 'consume' | 'oven'
		| 'merge_in' | 'merge_out' | 'release' | 'quarantine' | 'retire' | 'void' | 'audit';
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
	// ONE query, not two (perf, 2026-09-25): this sits on every scan-in and every
	// audit scan, so the id probe and the sticker probe go together. Both fields
	// are indexed, so this is an index OR, and the two can never collide — a
	// sticker matching /^BKT-\d+$/ is refused by assertStickerFree.
	const hit = await ProductionBucket.findOne({
		$or: [{ _id: raw.toUpperCase() }, { barcode: { $in: [raw, raw.toLowerCase(), raw.toUpperCase()] } }]
	}).select('_id').lean() as any;
	return hit ? hit._id : null;
}

/**
 * Guard for every place a CartridgeRecord is born. A bucket wearing a UUID
 * sticker looks exactly like a cartridge to a scanner; without this, scanning
 * a tub into a cartridge field would mint a phantom cartridge whose id is a
 * bucket's label.
 */
/**
 * A fast scanner can read two 36-character labels as one string. Carts are born
 * at bucket scan-in now, so the backstop master added at WI-01 (2026-09-24, after
 * 87 merged codes became cartridge records) belongs here too.
 */
export function assertNotMergedBarcode(code: string): void {
	if (splitMergedBarcodes(code ?? '')) {
		throw new BucketError(`Two barcodes were read as one (${(code ?? '').trim().length} characters). Scan one cart at a time.`);
	}
}

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

export interface CartStatusLine {
	found: boolean;
	cartridgeId: string | null;
	line: string;
}

/**
 * One-line status for a scanned cart QR (board lookup box, §9.1). Read-only:
 * the operator scans a cart and gets back where it is, nothing else. A bucket
 * sticker scanned here is reported as such rather than "not found".
 */
export async function cartStatusLine(code: string): Promise<CartStatusLine> {
	await connectDB();
	const raw = (code ?? '').trim();
	if (!raw) return { found: false, cartridgeId: null, line: 'Scan a cart QR.' };

	const cart = await CartridgeRecord.findById(raw)
		.select('_id status statusUpdatedOn bucket backing').lean() as any;
	if (!cart) {
		const bucketId = await resolveBucketId(raw);
		if (bucketId) return { found: false, cartridgeId: null, line: `${raw} is bucket ${bucketId}, not a cart — use the bucket scan box above.` };
		return { found: false, cartridgeId: null, line: `No cart with code ${raw}. A cart exists once it is scanned into a bucket at Barcoded.` };
	}

	const status = String(cart.status ?? '');
	const label = isBucketStage(status) ? STAGE_LABELS[status as BucketStage]
		: status || 'unknown';

	const parts: string[] = [`${cart._id} · ${label}`];
	// Where it belongs = the open pass whose member list names it (2026-09-25, for
	// the leftover panel's search). Membership is the authority, not the cart's own
	// `bucket.cycleId`, which an audit "take off pass" or a merge can leave stale.
	const home = await BucketCycle.findOne({ status: 'open', cartridgeIds: cart._id }).select('bucketId cycleNumber stage').lean() as any;
	if (home) {
		parts.push(`belongs in bucket ${home.bucketId} #${home.cycleNumber} (${STAGE_LABELS[home.stage as BucketStage] ?? home.stage})`);
	} else if (cart.bucket?.cycleId) {
		const cycle = await BucketCycle.findById(cart.bucket.cycleId).select('bucketId cycleNumber stage status').lean() as any;
		if (cycle) {
			const where = `bucket ${cycle.bucketId} #${cycle.cycleNumber}`;
			parts.push(cycle.status === 'open' ? `on no open pass — last in ${where}, taken off` : `last seen in ${where}, pass closed`);
		}
	} else if (isBucketStage(status)) {
		parts.push('on no open pass');
	}
	if (status === BACKED_STATUS && cart.backing?.parentLotRecordId) parts.push(`WI-01 lot ${cart.backing.parentLotRecordId} (legacy)`);
	if (cart.statusUpdatedOn) parts.push(`since ${new Date(cart.statusUpdatedOn).toLocaleString()}`);

	return { found: true, cartridgeId: cart._id, line: parts.join(' · ') };
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
 * Open a pass at Barcoded with zero members. Shells are then scanned in one at a
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
			stage: 'barcoded',
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
	await logTx({ bucketId, cycleId, type: 'create', fromStage: null, toStage: 'barcoded', qtyBefore: 0, qtyAfter: 0, relatedId: shell.lot.lotId, operator: input.user });
	await audit('bucket_cycles', cycleId, 'INSERT', input.user, { bucketId, cycleNumber, shellLot: shell.lot.lotId, labelLot: label.lot.lotId, emptyConfirmed: !!bucket.spotCheckPending });
	return BucketCycle.findById(cycleId).lean();
}

export interface ScanCartInput {
	cycleId: string;
	barcode: string;
	user: Operator;
}

/**
 * The cartridge's birth. Only while the pass is at Barcoded. Refuses a code that
 * is already a cartridge or a bucket's sticker. Debits one shell + one label
 * against the pass's lots.
 */
export async function scanCartIn(input: ScanCartInput): Promise<{ quantity: number; barcode: string }> {
	assertNotMergedBarcode(input.barcode ?? '');
	const barcode = (input.barcode ?? '').trim();
	if (!barcode) throw new BucketError('Scan the cartridge QR.');
	if (/^BKT-\d+$/i.test(barcode)) throw new BucketError('That is a bucket id, not a cartridge sticker.');
	await connectDB();

	// PERF (2026-09-25): these three reads are independent — the pass, the
	// bucket-label collision guard (§10) and "is this sticker already a cart".
	// Awaiting them in series was most of the scan's latency; the operator is
	// scanning shells at a rapid pace, so the guards go together.
	const [cycle, bucketLabelId, existing] = await Promise.all([
		BucketCycle.findById(input.cycleId).lean() as Promise<any>,
		resolveBucketId(barcode),
		CartridgeRecord.findById(barcode).select('_id status bucket').lean() as Promise<any>
	]);

	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	if (cycle.stage !== 'barcoded') throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is at ${STAGE_LABELS[cycle.stage as BucketStage]} — carts can only be scanned in while a bucket is at Barcoded.`);
	if (bucketLabelId) throw new BucketError(`${barcode} is the QR sticker on production bucket ${bucketLabelId}, not a cartridge.`, 409, 'BUCKET_LABEL');
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
			status: 'barcoded',
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
	const label = cycleLabel(cycle.bucketId, cycle.cycleNumber);

	// PERF (2026-09-25): membership, the two debits and the two log rows do not
	// depend on each other, so they go in one round trip group instead of six in
	// series. The membership update is first in the list so that if the group
	// does fail part-way the pass is the likeliest thing to be right; a partial
	// failure here needs the same manual repair it always did (void the pass, or
	// un-scan the cart) — the cartridge record above is the one ordering that
	// still matters, since nothing may be debited for a cart that was not born.
	await Promise.all([
		BucketCycle.updateOne({ _id: cycle._id }, { $addToSet: { cartridgeIds: barcode }, $inc: { quantity: 1 } }),
		debit(SHELL_PART, shellLot, 1, cycle._id, input.user, `Scan-in ${barcode} into ${label}: 1x ${SHELL_PART} shell from lot ${shellLot ?? '(none)'}`),
		debit(LABEL_PART, labelLot, 1, cycle._id, input.user, `Scan-in ${barcode} into ${label}: 1x ${LABEL_PART} label from lot ${labelLot ?? '(none)'}`),
		logTx({ bucketId: cycle.bucketId, cycleId: cycle._id, type: 'scan_in', fromStage: 'barcoded', toStage: 'barcoded', qtyBefore: before, qtyAfter: before + 1, cartridgeIds: [barcode], operator: input.user }),
		audit('cartridge_records', barcode, 'INSERT', input.user, { status: 'barcoded', bucketId: cycle.bucketId, cycleId: cycle._id })
	]);
	// No re-read of the pass: the caller only needs the new count, and the board
	// tracks its own membership between refreshes (§9.1).
	return { quantity: before + 1, barcode };
}

/**
 * Undo a mis-scan while the pass is still at Barcoded: the cartridge record is
 * deleted (it was born seconds ago and has no history) and the shell + label
 * debits are retracted.
 */
export async function unscanCart(input: ScanCartInput): Promise<{ quantity: number; barcode: string }> {
	const barcode = (input.barcode ?? '').trim();
	await connectDB();
	const [cycle, cart] = await Promise.all([
		BucketCycle.findById(input.cycleId).lean() as Promise<any>,
		CartridgeRecord.findById(barcode).select('status bucket').lean() as Promise<any>
	]);
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	if (cycle.stage !== 'barcoded') throw new BucketError('Carts can only be un-scanned while the bucket is at Barcoded — after that, use Discard.');
	if (!(cycle.cartridgeIds ?? []).includes(barcode)) throw new BucketError(`${barcode} is not in ${cycleLabel(cycle.bucketId, cycle.cycleNumber)}.`);
	if (!cart || cart.status !== 'barcoded' || cart.bucket?.cycleId !== cycle._id) throw new BucketError(`${barcode} is no longer a barcoded member of this pass.`);

	// The CartridgeRecord model carries the sacred middleware, whose delete hooks
	// throw unconditionally — and in Mongoose 9 `pre('deleteOne')` with no
	// options is QUERY middleware, so `CartridgeRecord.deleteOne()` fired it and
	// this button had never once worked (it 500'd; the board swallowed it).
	// hardDeleteUnfinalizedCartridges is the one sanctioned driver-level path and
	// writes the AuditLog row itself. Bug found 2026-09-25.
	const label = cycleLabel(cycle.bucketId, cycle.cycleNumber);
	const removed = await hardDeleteUnfinalizedCartridges(
		{ _id: barcode },
		{
			statuses: ['barcoded'],
			reason: 'Operator removed mis-scanned cartridge while bucket at Barcoded',
			user: input.user,
			oldData: { cycleId: cycle._id, bucketId: cycle.bucketId }
		}
	);
	if (removed.length === 0) throw new BucketError(`${barcode} could not be removed — reload the board and try again.`, 409);

	const before: number = cycle.quantity ?? 0;
	const [shellPartId, labelPartId] = await Promise.all([resolvePartId(SHELL_PART), resolvePartId(LABEL_PART)]);
	await Promise.all([
		BucketCycle.updateOne({ _id: cycle._id }, { $pull: { cartridgeIds: barcode }, $inc: { quantity: -1 } }),
		retract('consumption', shellPartId, lotFor(cycle.sourceLots, SHELL_PART) ?? null, 1, cycle._id, input.user, `Un-scan ${barcode} from ${label}: 1x ${SHELL_PART} returned`),
		retract('consumption', labelPartId, lotFor(cycle.sourceLots, LABEL_PART) ?? null, 1, cycle._id, input.user, `Un-scan ${barcode} from ${label}: 1x ${LABEL_PART} returned`),
		logTx({ bucketId: cycle.bucketId, cycleId: cycle._id, type: 'unscan', fromStage: 'barcoded', toStage: 'barcoded', qtyBefore: before, qtyAfter: Math.max(0, before - 1), cartridgeIds: [barcode], reason: 'mis-scan removed', operator: input.user })
	]);
	return { quantity: Math.max(0, before - 1), barcode };
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
	thermosealLotId?: string;   // THERMOSEAL_PART lot to pull the NEXT roll from, if one is opened (optional; FIFO default)
	discardedIds?: string[];    // carts binned at this step (scanned)
	discardJournal?: string;    // required when discardedIds is non-empty
}

/**
 * Move the whole bucket one stage forward. Discards are recorded first (so a
 * discard is never written for a move that then fails, and the thermoseal
 * debit covers only carts that move), then every remaining member's status
 * follows the bucket. barcoded → unpressed takes members × 3.75 cm of thermoseal
 * off the open roll (thermoseal-service); the roll pull, if one happens, is
 * where thermoseal inventory actually moves.
 */
export async function advanceCycle(input: AdvanceCycleInput): Promise<{ cycle: any | null; discarded: number; closed: boolean; thermoseal: ConsumeResult | null }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	const from = cycle.stage as BucketStage;
	const to = nextStage(from);
	if (!to) throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is already ${STAGE_LABELS.backing} — wax filling draws its carts from here.`);
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
	if (from === 'barcoded') set.openedQty = moving.length; // the pass's "opened with" count is fixed when it leaves Barcoded
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
	// Pressed → Backed stamps the backing block the way WI-01 used to, minus the
	// lot: downstream views (pipeline, dashboard, DHR) group backed carts by
	// backing.bucketCycleId and show who backed them and when.
	const backedStamp = to === BACKED_STAGE
		? { 'backing.recordedAt': now, 'backing.operator': { _id: input.user._id, username: input.user.username }, 'backing.bucketCycleId': cycle._id, 'backing.bucketBarcode': cycle.bucketId }
		: {};
	await CartridgeRecord.updateMany(
		{ _id: { $in: moving } },
		{ $set: { status: to, statusUpdatedOn: now.toISOString(), priorStatus: from, ...(thermosealLot ? { 'backing.thermosealLot': thermosealLot } : {}), ...backedStamp } }
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
	barcodes: string[];   // cartridges the wax-fill operator scanned onto the deck
	waxRunId: string;     // WaxFillingRun._id (ledger relatedId)
	user: Operator;
}

/**
 * Wax-fill handoff: the scanned cartridges leave the bucket. The caller (wax
 * filling's deck load) sets their status to 'wax_filling' and stamps the run;
 * this only maintains the membership list and closes the pass when the last
 * member leaves. Nothing is debited — every part was consumed upstream.
 */
export async function consumeCarts(input: ConsumeInput): Promise<{ qtyBefore: number; qtyAfter: number; consumed: string[] }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	if (cycle.stage !== BACKED_STAGE) {
		throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is at ${STAGE_LABELS[cycle.stage as BucketStage]} — only ${STAGE_LABELS.backing} buckets feed wax filling. Advance it on the board first.`);
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
		fromStage: BACKED_STAGE, toStage: BACKED_STAGE, qtyBefore: before, qtyAfter: after,
		relatedId: input.waxRunId, cartridgeIds: ids, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'CONSUME', input.user, { consumed: ids.length, quantity: after, waxRunId: input.waxRunId }, { quantity: before });
	if (after === 0) await closeCycle({ ...cycle, quantity: 0 }, 'consumed', input.user, input.waxRunId);
	return { qtyBefore: before, qtyAfter: after, consumed: ids };
}

export interface MoveToOvenInput { cycleId: string; user: Operator }

/**
 * "Move to oven" (user, 2026-09-25): all it does is free the carts from the
 * bucket and return the bucket to Available. The pass closes; the carts are not
 * written at all — they keep status 'backing' until wax filling scans them in.
 * A later cancelled wax run does not put them back into the pass: returnCarts
 * treats an oven-released pass as loose.
 */
export async function moveToOven(input: MoveToOvenInput): Promise<{ cycleId: string; bucketId: string; cycleNumber: number; released: string[] }> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle || cycle.status !== 'open') throw new BucketError('Pass is not open.', 404);
	if (cycle.stage !== BACKED_STAGE) {
		throw new BucketError(`${cycleLabel(cycle.bucketId, cycle.cycleNumber)} is at ${STAGE_LABELS[cycle.stage as BucketStage]} — only a ${STAGE_LABELS.backing} bucket goes to the oven. Advance it first.`);
	}
	const ids: string[] = cycle.cartridgeIds ?? [];
	const now = new Date();
	const op = { _id: input.user._id, username: input.user.username };
	await BucketCycle.updateOne({ _id: cycle._id }, { $set: { ovenReleasedAt: now, ovenReleasedBy: op } });
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'oven',
		fromStage: BACKED_STAGE, toStage: BACKED_STAGE, qtyBefore: ids.length, qtyAfter: 0,
		reason: `moved to oven — ${ids.length} cart${ids.length === 1 ? '' : 's'} released from the bucket`, cartridgeIds: ids, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'MOVE_TO_OVEN', input.user, { released: ids.length, ovenReleasedAt: now }, { quantity: cycle.quantity });
	await closeCycle({ ...cycle, quantity: 0 }, 'consumed', input.user);
	return { cycleId: cycle._id, bucketId: cycle.bucketId, cycleNumber: cycle.cycleNumber, released: ids };
}

/**
 * "In oven": backed carts that are on no open pass — freed by Move to oven (or
 * by a cancelled wax run, or drawn by the old WI-01 page). Shown as a short
 * dropdown inside the board's Backed column, never as a card of its own (user,
 * 2026-09-25). They stay here until wax filling scans them in.
 */
export async function inOvenCarts(limit = 200): Promise<{ count: number; ids: string[] }> {
	await connectDB();
	const open = await BucketCycle.find({ status: 'open', stage: BACKED_STAGE }).select('cartridgeIds').lean() as any[];
	const inBucket = open.flatMap(c => (c.cartridgeIds ?? []) as string[]);
	const q = { status: BACKED_STATUS, ...(inBucket.length ? { _id: { $nin: inBucket } } : {}) };
	const [count, rows] = await Promise.all([
		CartridgeRecord.countDocuments(q),
		CartridgeRecord.find(q).select('_id').sort({ statusUpdatedOn: -1 }).limit(limit).lean() as any as Promise<{ _id: string }[]>
	]);
	return { count, ids: rows.map(r => r._id) };
}

export interface ReturnInput {
	barcodes: string[];   // carts a cancelled/aborted wax run is handing back
	waxRunId: string;
	reason: string;
	user: Operator;
}

/**
 * Inverse of consumeCarts for a cancelled or aborted wax run: each cart goes
 * back into the pass it was drawn from (its `bucket.cycleId`). If that pass
 * has already closed and the tub has not started a new pass, the pass is
 * reopened at Backed and the tub goes back to in_use; if the tub is busy with
 * a newer pass the cart stays loose at 'backing' (still loadable) and is
 * reported in `loose`. The caller sets the carts' status back to 'backing'.
 */
export async function returnCarts(input: ReturnInput): Promise<{ returned: string[]; loose: string[] }> {
	await connectDB();
	const ids = cleanCodes(input.barcodes);
	if (ids.length === 0) return { returned: [], loose: [] };
	const carts = await CartridgeRecord.find({ _id: { $in: ids } }).select('_id bucket.cycleId').lean() as any[];
	const byCycle = new Map<string, string[]>();
	const loose: string[] = [];
	for (const c of carts) {
		const cid = c.bucket?.cycleId;
		if (!cid) { loose.push(c._id); continue; }
		byCycle.set(cid, [...(byCycle.get(cid) ?? []), c._id]);
	}
	const returned: string[] = [];
	for (const [cycleId, members] of byCycle) {
		const cycle = await BucketCycle.findById(cycleId).lean() as any;
		// An oven-released pass (moveToOven) is over: its carts are loose by design.
		if (!cycle || cycle.status === 'voided' || cycle.stage !== BACKED_STAGE || cycle.ovenReleasedAt) { loose.push(...members); continue; }
		if (cycle.status !== 'open') {
			// Reopen only if the tub is free; a tub already on a newer pass cannot hold two.
			const claimed = await ProductionBucket.findOneAndUpdate(
				{ _id: cycle.bucketId, state: 'available' },
				{ $set: { state: 'in_use', currentCycleId: cycle._id, spotCheckPending: false } }
			).lean();
			if (!claimed) { loose.push(...members); continue; }
			await BucketCycle.updateOne({ _id: cycle._id }, { $set: { status: 'open', closedAt: null } });
		}
		const before: number = cycle.status === 'open' ? (cycle.quantity ?? 0) : 0;
		const after = before + members.length;
		await BucketCycle.updateOne({ _id: cycle._id }, { $addToSet: { cartridgeIds: { $each: members } }, $set: { quantity: after } });
		await logTx({
			bucketId: cycle.bucketId, cycleId: cycle._id, type: 'merge_in',
			fromStage: BACKED_STAGE, toStage: BACKED_STAGE, qtyBefore: before, qtyAfter: after,
			relatedId: input.waxRunId, reason: `returned by wax filling: ${input.reason}`, cartridgeIds: members, operator: input.user
		});
		await audit('bucket_cycles', cycle._id, 'RETURN', input.user, { returned: members.length, quantity: after, waxRunId: input.waxRunId, reopened: cycle.status !== 'open' }, { quantity: before, status: cycle.status }, input.reason);
		returned.push(...members);
	}
	return { returned, loose };
}

// ── residual flow (§7, v2: scan the leftover carts) ───────────────────────

export interface ResidualInput {
	bucketId: string;
	barcodes: string[];           // the leftover cartridges found in the tub, scanned
	disposition: ResidualDisposition;
	destinationBucketId?: string; // merge (legacy: one destination for every cart)
	moves?: { barcode: string; destinationBucketId: string }[]; // merge: per-cart destination (v2 leftover flow)
	journal?: string;             // required for scrap
	user: Operator;
}

export interface ResidualLookup {
	barcode: string;
	status: string | null;
	stage: BucketStage | null;
	ok: boolean;
	reason?: string;
}

/**
 * What a scanned leftover cart is, before anything is written: known? still a
 * bucket-stage cart? not sitting in an open pass? The board uses the stage to
 * suggest where it should go (an open pass at that stage → an empty bucket →
 * mint one).
 */
export async function lookupResidualCart(barcode: string): Promise<ResidualLookup> {
	await connectDB();
	const code = (barcode ?? '').trim();
	if (!code) return { barcode: code, status: null, stage: null, ok: false, reason: 'Empty scan.' };
	if (await resolveBucketId(code)) return { barcode: code, status: null, stage: null, ok: false, reason: 'That is a bucket label, not a cart.' };
	const cart = await CartridgeRecord.findById(code).select('_id status').lean() as any;
	if (!cart) return { barcode: code, status: null, stage: null, ok: false, reason: 'Not a known cartridge — leftovers must have been scanned into a bucket before.' };
	if (!isBucketStage(cart.status)) return { barcode: code, status: cart.status ?? null, stage: null, ok: false, reason: `Already past the buckets (${cart.status}).` };
	const member = await BucketCycle.findOne({ status: 'open', cartridgeIds: code }).select('bucketId cycleNumber').lean() as any;
	if (member) return { barcode: code, status: cart.status, stage: cart.status, ok: false, reason: `Still a member of ${cycleLabel(member.bucketId, member.cycleNumber)} — discard or un-scan it there.` };
	return { barcode: code, status: cart.status, stage: cart.status, ok: true };
}

/**
 * Leftovers found in a tub. Each scanned code must be a known cartridge that
 * is still pre-oven (barcoded / unpressed / pressed) and not a member of any open
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

	let reopenedSelf = false;
	if (input.disposition === 'merge') {
		// Destinations: per cart (v2 leftover flow) or one for all (legacy form).
		const moves = (input.moves && input.moves.length)
			? input.moves
			: ids.map(barcode => ({ barcode, destinationBucketId: (input.destinationBucketId ?? '').trim() }));
		const missing = ids.filter(id => !moves.some(m => m.barcode === id && (m.destinationBucketId ?? '').trim()));
		if (missing.length) throw new BucketError(`Pick a destination bucket for: ${missing.join(', ')}`);
		// Resolve + validate every destination before any write.
		const groups = new Map<string, string[]>();
		for (const m of moves) {
			if (!ids.includes(m.barcode)) continue;
			const destId = await resolveBucketId((m.destinationBucketId ?? '').trim());
			if (!destId) throw new BucketError(`"${m.destinationBucketId}" is not a known bucket.`, 404);
			groups.set(destId, [...(groups.get(destId) ?? []), m.barcode]);
		}
		type Plan = { destId: string; ids: string[]; stage: BucketStage; open: any | null; bucket: any };
		const plans: Plan[] = [];
		for (const [destId, groupIds] of groups) {
			const stages = new Set(groupIds.map(id => byId.get(id).status as BucketStage));
			if (stages.size > 1) throw new BucketError(`Carts going to ${destId} are at different stages (${[...stages].map(st => STAGE_LABELS[st]).join(', ')}) — one destination per stage.`);
			const stage = [...stages][0];
			const destBucket = destId === bucketId ? bucket : await ProductionBucket.findById(destId).lean() as any;
			if (!destBucket) throw new BucketError(`Bucket ${destId} not found.`, 404);
			if (destBucket.state === 'retired') throw new BucketError(`Bucket ${destId} is retired.`);
			const open = await getOpenCycle(destId);
			if (open) {
				if (open.stage !== stage) throw new BucketError(`${cycleLabel(destId, open.cycleNumber)} is at ${STAGE_LABELS[open.stage as BucketStage]}, but these carts are ${STAGE_LABELS[stage]}.`);
			} else if (destBucket.state !== 'available') {
				throw new BucketError(`Bucket ${destId} is ${destBucket.state} and has no open pass.`);
			}
			plans.push({ destId, ids: groupIds, stage, open, bucket: destBucket });
		}
		const destinations: { bucketId: string; cycleId: string; stage: BucketStage; qty: number; newPass: boolean }[] = [];
		for (const plan of plans) {
			const n = plan.ids.length;
			if (plan.open) {
				await BucketCycle.updateOne({ _id: plan.open._id }, { $addToSet: { cartridgeIds: { $each: plan.ids } }, $set: { quantity: (plan.open.quantity ?? 0) + n } });
				await CartridgeRecord.updateMany(
					{ _id: { $in: plan.ids } },
					{ $set: { statusUpdatedOn: now.toISOString(), 'bucket.bucketId': plan.destId, 'bucket.cycleId': plan.open._id, 'backing.bucketCycleId': plan.open._id, 'backing.bucketBarcode': plan.destId } }
				);
				await logTx({ bucketId: plan.destId, cycleId: plan.open._id, type: 'merge_in', fromStage: plan.stage, toStage: plan.stage, qtyBefore: plan.open.quantity ?? 0, qtyAfter: (plan.open.quantity ?? 0) + n, reason: `residual from ${bucketId}${journal ? `: ${journal}` : ''}`, relatedId: prevCycle?._id, cartridgeIds: plan.ids, operator: input.user });
				await audit('bucket_cycles', plan.open._id, 'MERGE_IN', input.user, { from: bucketId, cartridgeIds: plan.ids, quantity: (plan.open.quantity ?? 0) + n }, { quantity: plan.open.quantity });
				destinations.push({ bucketId: plan.destId, cycleId: plan.open._id, stage: plan.stage, qty: n, newPass: false });
			} else {
				// Empty bucket: open a fresh pass AT THE CARTS' STAGE holding them. Nothing is
				// debited — these carts were paid for when they were first scanned in; the
				// source lots are carried over from the pass they were found after.
				const cycleNumber = (plan.bucket.cycleCount ?? 0) + 1;
				const cycleId = generateId();
				await BucketCycle.create({
					_id: cycleId, bucketId: plan.destId, cycleNumber, stage: plan.stage,
					cartridgeIds: plan.ids, quantity: n, openedQty: n,
					sourceLots: (prevCycle?.sourceLots ?? []).map((l: any) => ({ partNumber: l.partNumber, lotId: l.lotId, scannedAt: l.scannedAt ?? now })),
					status: 'open', openedBy: by, openedAt: now, stageEnteredAt: now,
					emptyConfirmedBy: by, emptyConfirmedAt: now
				});
				await ProductionBucket.updateOne({ _id: plan.destId }, { $set: { state: 'in_use', currentCycleId: cycleId, cycleCount: cycleNumber, spotCheckPending: false }, $unset: { residualNote: 1 } });
				await CartridgeRecord.updateMany(
					{ _id: { $in: plan.ids } },
					{ $set: { statusUpdatedOn: now.toISOString(), 'bucket.bucketId': plan.destId, 'bucket.cycleId': cycleId, 'backing.bucketCycleId': cycleId, 'backing.bucketBarcode': plan.destId } }
				);
				await logTx({ bucketId: plan.destId, cycleId, type: 'create', fromStage: plan.stage, toStage: plan.stage, qtyBefore: 0, qtyAfter: n, reason: `pass opened at ${STAGE_LABELS[plan.stage]} from residual carts of ${bucketId}${journal ? `: ${journal}` : ''}`, relatedId: prevCycle?._id, cartridgeIds: plan.ids, operator: input.user });
				await audit('bucket_cycles', cycleId, 'CREATE', input.user, { bucketId: plan.destId, cycleNumber, stage: plan.stage, cartridgeIds: plan.ids, fromResidualOf: bucketId });
				if (plan.destId === bucketId) reopenedSelf = true;
				destinations.push({ bucketId: plan.destId, cycleId, stage: plan.stage, qty: n, newPass: true });
			}
		}
		await logTx({ bucketId, cycleId: prevCycle?._id ?? null, type: 'merge_out', fromStage: prevCycle?.stage, toStage: prevCycle?.stage, qtyBefore: qty, qtyAfter: 0, reason: `residual merged → ${destinations.map(d => `${d.bucketId}${d.newPass ? ' (new pass)' : ''} ×${d.qty}`).join(', ')}${journal ? `: ${journal}` : ''}`, relatedId: destinations[0]?.cycleId, cartridgeIds: ids, operator: input.user });
		found.destinations = destinations;
		found.destinationCycleId = destinations[0]?.cycleId;
		relatedId = destinations[0]?.cycleId;
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
	} else if ((input.disposition as string) === 'defer') {
		// Quarantine was removed as a category (user, 2026-09-23). Legacy quarantined
		// buckets still resolve through merge / scrap; nothing new is quarantined.
		throw new BucketError('Quarantine was removed — merge the leftover carts into a bucket or discard them.');
	} else {
		throw new BucketError('Unknown disposition.');
	}

	if (!reopenedSelf) {
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

// ── bucket audit (§9.8) ───────────────────────────────────────────────────

export interface AuditScanResult {
	barcode: string;
	finding: 'member' | 'foreign' | 'ineligible' | 'unknown' | 'bucket';
	status: string | null;
	stage: BucketStage | null;
	homeBucketId: string | null;   // the open pass this cart is a member of, if any
	homeCycleId: string | null;
	homeLabel: string | null;
	note: string;
}

/** One scan during an audit, classified before anything is written. */
export async function auditScan(cycleId: string, barcode: string): Promise<AuditScanResult> {
	await connectDB();
	const code = (barcode ?? '').trim();
	const base = { barcode: code, status: null, stage: null, homeBucketId: null, homeCycleId: null, homeLabel: null };
	if (!code) return { ...base, finding: 'unknown', note: 'Empty scan.' };

	const cycle = await BucketCycle.findById(cycleId).select('_id bucketId cycleNumber cartridgeIds').lean() as any;
	if (!cycle) throw new BucketError('That pass no longer exists — reload the board.', 404);

	const asBucket = await resolveBucketId(code);
	if (asBucket) return { ...base, finding: 'bucket', note: `${code} is bucket ${asBucket}, not a cart.` };

	const cart = await CartridgeRecord.findById(code).select('_id status').lean() as any;
	if (!cart) return { ...base, finding: 'unknown', note: `${code} is not a known cartridge — it was never scanned into a bucket.` };

	const status = String(cart.status ?? '');
	if ((cycle.cartridgeIds ?? []).includes(code)) {
		return { ...base, status, stage: isBucketStage(status) ? status as BucketStage : null, finding: 'member', note: `${code} belongs here.` };
	}

	const home = await BucketCycle.findOne({ status: 'open', cartridgeIds: code }).select('_id bucketId cycleNumber stage').lean() as any;
	const homeLabel = home ? cycleLabel(home.bucketId, home.cycleNumber) : null;
	const homeBits = { homeBucketId: home?.bucketId ?? null, homeCycleId: home?._id ?? null, homeLabel };

	if (!isBucketStage(status)) {
		return { ...base, ...homeBits, status, finding: 'ineligible',
			note: `${code} is ${status || 'unknown'} — past the buckets. Take it out of the tub; the board will not move it.` };
	}
	return {
		barcode: code, finding: 'foreign', status, stage: status as BucketStage, ...homeBits,
		note: home
			? `${code} is a member of ${homeLabel} (${STAGE_LABELS[home.stage as BucketStage]}) — wrong tub.`
			: `${code} is ${STAGE_LABELS[status as BucketStage]} and is on no open pass.`
	};
}

export interface AuditCycleInput {
	cycleId: string;
	scanned: string[];                                            // every code scanned in the tub
	moves?: { barcode: string; destinationBucketId: string }[];    // foreign carts → where they belong
	discards?: string[];                                          // foreign carts to scrap
	// Members that were not in the tub: keep them on the pass (default), scrap them,
	// or take them off the pass without scrapping (they are somewhere else).
	missingActions?: { barcode: string; action: 'discard' | 'release' }[];
	journal?: string;                                             // required when anything is removed
	user: Operator;
}

export interface AuditCycleResult {
	cycleId: string;
	bucketId: string;
	cycleNumber: number;
	expected: number;
	present: string[];
	missing: string[];
	moved: { barcode: string; fromCycleId: string | null; destinationBucketId: string; destinationCycleId: string; newPass: boolean; returned: boolean }[];
	discarded: string[];
	missingDiscarded: string[];   // members not found, scrapped
	missingReleased: string[];    // members not found, taken off the pass as loose carts
	quantityAfter: number;
}

/**
 * Audit an open pass: the operator scans every cart in the tub, and each code
 * that is not a member is either moved to where it belongs or discarded.
 * Members that were never scanned are reported as missing and stay members —
 * an audit never silently rewrites the count (§7.1). Everything is validated
 * before the first write.
 */
export async function auditCycle(input: AuditCycleInput): Promise<AuditCycleResult> {
	await connectDB();
	const cycle = await BucketCycle.findById(input.cycleId).lean() as any;
	if (!cycle) throw new BucketError('Pass not found.', 404);
	if (cycle.status !== 'open') throw new BucketError('That pass is closed — audit an open pass.');

	const scanned = cleanCodes(input.scanned);
	const members: string[] = cycle.cartridgeIds ?? [];
	const present = members.filter(id => scanned.includes(id));
	const missing = members.filter(id => !scanned.includes(id));
	const foreign = scanned.filter(id => !members.includes(id));

	const discards = cleanCodes(input.discards).filter(id => foreign.includes(id));
	const moves = (input.moves ?? []).filter(m => foreign.includes(m.barcode) && !discards.includes(m.barcode));
	const undecided = foreign.filter(id => !discards.includes(id) && !moves.some(m => m.barcode === id));
	if (undecided.length) throw new BucketError(`Say what happens to: ${undecided.join(', ')} — move each one to a bucket or discard it.`);

	const missingActions = (input.missingActions ?? []).filter(m => missing.includes(m.barcode));
	const missingDiscards = missingActions.filter(m => m.action === 'discard').map(m => m.barcode);
	const missingReleases = missingActions.filter(m => m.action === 'release').map(m => m.barcode);

	const journal = (input.journal ?? '').trim();
	if ((discards.length || missingDiscards.length || missingReleases.length) && !journal) {
		throw new BucketError('A journal entry describing why carts were discarded or taken off the pass is required.');
	}

	// Validate every foreign cart before writing anything.
	const carts = foreign.length
		? await CartridgeRecord.find({ _id: { $in: foreign } }).select('_id status').lean() as any[]
		: [];
	const byId = new Map<string, any>(carts.map(c => [c._id, c]));
	const unknown = foreign.filter(id => !byId.has(id));
	if (unknown.length) throw new BucketError(`Not known cartridges: ${unknown.join(', ')}`);
	const tooFar = carts.filter(c => !isBucketStage(c.status));
	if (tooFar.length) throw new BucketError(`Past the buckets, so the board will not move them: ${tooFar.map(c => `${c._id} (${c.status})`).join(', ')} — take them out of the tub.`);

	// Where each foreign cart is a member today (so it can be pulled out of that pass).
	const homes = foreign.length
		? await BucketCycle.find({ status: 'open', cartridgeIds: { $in: foreign } }).select('_id bucketId cycleNumber stage quantity cartridgeIds').lean() as any[]
		: [];
	const homeOf = new Map<string, any>();
	for (const h of homes) for (const id of (h.cartridgeIds ?? [])) if (foreign.includes(id)) homeOf.set(id, h);

	// Resolve + check every destination first.
	type Plan = { destId: string; ids: string[]; stage: BucketStage; open: any | null; bucket: any };
	const groups = new Map<string, string[]>();
	for (const m of moves) {
		const destId = await resolveBucketId((m.destinationBucketId ?? '').trim());
		if (!destId) throw new BucketError(`"${m.destinationBucketId}" is not a known bucket.`, 404);
		groups.set(destId, [...(groups.get(destId) ?? []), m.barcode]);
	}
	const plans: Plan[] = [];
	for (const [destId, ids] of groups) {
		const stages = new Set(ids.map(id => byId.get(id).status as BucketStage));
		if (stages.size > 1) throw new BucketError(`Carts going to ${destId} are at different stages (${[...stages].map(st => STAGE_LABELS[st]).join(', ')}) — one destination per stage.`);
		const stage = [...stages][0];
		const bucket = await ProductionBucket.findById(destId).lean() as any;
		if (!bucket) throw new BucketError(`Bucket ${destId} not found.`, 404);
		if (bucket.state === 'retired') throw new BucketError(`Bucket ${destId} is retired.`);
		const open = await getOpenCycle(destId);
		if (open) {
			if (open.stage !== stage) throw new BucketError(`${cycleLabel(destId, open.cycleNumber)} is at ${STAGE_LABELS[open.stage as BucketStage]}, but those carts are ${STAGE_LABELS[stage]}.`);
		} else if (bucket.state !== 'available') {
			throw new BucketError(`Bucket ${destId} is ${bucket.state} and has no open pass.`);
		}
		plans.push({ destId, ids, stage, open, bucket });
	}

	const now = new Date();
	const by = { _id: input.user._id, username: input.user.username };
	const auditNote = `audit of ${cycleLabel(cycle.bucketId, cycle.cycleNumber)}`;
	const moved: AuditCycleResult['moved'] = [];

	for (const plan of plans) {
		// A cart already on the destination pass is simply put back in the right tub:
		// nothing to write but the audit trail.
		const alreadyThere = plan.open ? plan.ids.filter(id => homeOf.get(id)?._id === plan.open._id) : [];
		const toMove = plan.ids.filter(id => !alreadyThere.includes(id));
		for (const id of alreadyThere) {
			moved.push({ barcode: id, fromCycleId: plan.open._id, destinationBucketId: plan.destId, destinationCycleId: plan.open._id, newPass: false, returned: true });
		}
		// Pull each moved cart out of the pass it is a member of today.
		for (const id of toMove) {
			const home = homeOf.get(id);
			if (!home) continue;
			const before = home.quantity ?? (home.cartridgeIds ?? []).length;
			await BucketCycle.updateOne({ _id: home._id }, { $pull: { cartridgeIds: id }, $set: { quantity: Math.max(0, before - 1) } });
			await logTx({ bucketId: home.bucketId, cycleId: home._id, type: 'merge_out', fromStage: home.stage, toStage: home.stage, qtyBefore: before, qtyAfter: Math.max(0, before - 1), reason: `${id} found in ${cycle.bucketId} during an audit → ${plan.destId}`, cartridgeIds: [id], operator: input.user });
			home.quantity = Math.max(0, before - 1);
		}
		if (toMove.length === 0) continue;

		if (plan.open) {
			const before = plan.open.quantity ?? 0;
			await BucketCycle.updateOne({ _id: plan.open._id }, { $addToSet: { cartridgeIds: { $each: toMove } }, $set: { quantity: before + toMove.length } });
			await CartridgeRecord.updateMany(
				{ _id: { $in: toMove } },
				{ $set: { statusUpdatedOn: now.toISOString(), 'bucket.bucketId': plan.destId, 'bucket.cycleId': plan.open._id, 'backing.bucketCycleId': plan.open._id, 'backing.bucketBarcode': plan.destId } }
			);
			await logTx({ bucketId: plan.destId, cycleId: plan.open._id, type: 'merge_in', fromStage: plan.stage, toStage: plan.stage, qtyBefore: before, qtyAfter: before + toMove.length, reason: `${auditNote}: ${toMove.length} cart(s) put back where they belong`, cartridgeIds: toMove, operator: input.user });
			await audit('bucket_cycles', plan.open._id, 'AUDIT_MERGE_IN', input.user, { from: cycle.bucketId, cartridgeIds: toMove, quantity: before + toMove.length }, { quantity: before });
			for (const id of toMove) moved.push({ barcode: id, fromCycleId: homeOf.get(id)?._id ?? null, destinationBucketId: plan.destId, destinationCycleId: plan.open._id, newPass: false, returned: false });
		} else {
			// Empty bucket: open a fresh pass at the carts' stage. Nothing is debited —
			// these carts were paid for when they were first scanned in.
			const cycleNumber = (plan.bucket.cycleCount ?? 0) + 1;
			const newCycleId = generateId();
			await BucketCycle.create({
				_id: newCycleId, bucketId: plan.destId, cycleNumber, stage: plan.stage,
				cartridgeIds: toMove, quantity: toMove.length, openedQty: toMove.length,
				sourceLots: (cycle.sourceLots ?? []).map((l: any) => ({ partNumber: l.partNumber, lotId: l.lotId, scannedAt: l.scannedAt ?? now })),
				status: 'open', openedBy: by, openedAt: now, stageEnteredAt: now,
				emptyConfirmedBy: by, emptyConfirmedAt: now
			});
			await ProductionBucket.updateOne({ _id: plan.destId }, { $set: { state: 'in_use', currentCycleId: newCycleId, cycleCount: cycleNumber, spotCheckPending: false }, $unset: { residualNote: 1 } });
			await CartridgeRecord.updateMany(
				{ _id: { $in: toMove } },
				{ $set: { statusUpdatedOn: now.toISOString(), 'bucket.bucketId': plan.destId, 'bucket.cycleId': newCycleId, 'backing.bucketCycleId': newCycleId, 'backing.bucketBarcode': plan.destId } }
			);
			await logTx({ bucketId: plan.destId, cycleId: newCycleId, type: 'create', fromStage: plan.stage, toStage: plan.stage, qtyBefore: 0, qtyAfter: toMove.length, reason: `pass opened at ${STAGE_LABELS[plan.stage]} from carts found in ${cycle.bucketId} during an audit`, relatedId: cycle._id, cartridgeIds: toMove, operator: input.user });
			await audit('bucket_cycles', newCycleId, 'CREATE', input.user, { bucketId: plan.destId, cycleNumber, stage: plan.stage, cartridgeIds: toMove, fromAuditOf: cycle.bucketId });
			for (const id of toMove) moved.push({ barcode: id, fromCycleId: homeOf.get(id)?._id ?? null, destinationBucketId: plan.destId, destinationCycleId: newCycleId, newPass: true, returned: false });
		}
	}

	// Discards: scrapped as whatever they are, out of whatever pass holds them.
	let removalId: string | undefined;
	if (discards.length) {
		removalId = generateId();
		for (const id of discards) {
			const home = homeOf.get(id);
			if (!home) continue;
			const before = home.quantity ?? (home.cartridgeIds ?? []).length;
			await BucketCycle.updateOne({ _id: home._id }, { $pull: { cartridgeIds: id }, $set: { quantity: Math.max(0, before - 1) } });
			await logTx({ bucketId: home.bucketId, cycleId: home._id, type: 'scrap', fromStage: home.stage, toStage: home.stage, qtyBefore: before, qtyAfter: Math.max(0, before - 1), reason: `${id} found in ${cycle.bucketId} during an audit and discarded: ${journal}`, journal, relatedId: removalId, cartridgeIds: [id], operator: input.user });
			home.quantity = Math.max(0, before - 1);
		}
		await CartridgeRecord.updateMany(
			{ _id: { $in: discards } },
			{ $set: { status: 'scrapped', statusUpdatedOn: now.toISOString() }, $push: { notes: { _id: generateId(), body: `Found in bucket ${cycle.bucketId} during an audit, discarded: ${journal}`, phase: 'bucket', author: by, createdAt: now } } }
		);
		await ManualCartridgeRemoval.create({ _id: removalId, cartridgeIds: discards, bucketCycleId: cycle._id, bucketId: cycle.bucketId, cartridgeCount: discards.length, reason: journal, journal, operator: by, removedAt: now });
		const byStage = new Map<BucketStage, number>();
		for (const id of discards) {
			const st = byId.get(id).status as BucketStage;
			byStage.set(st, (byStage.get(st) ?? 0) + 1);
		}
		for (const [stage, n] of byStage) {
			for (const pn of partsAtStage(stage)) {
				await debitScrap(pn, lotFor(cycle.sourceLots, pn), n, cycle._id, input.user, `audit discard: ${journal}`, `Audit of ${cycle.bucketId}: ${n}x ${pn} at ${STAGE_LABELS[stage]} scrapped — ${journal}`);
			}
		}
	}

	// Members that were not in the tub and the operator chose to remove. Scrapped
	// carts leave the pass and give their parts back as scrap; released carts leave
	// the pass and stay alive as loose carts (the leftover flow can re-home them).
	if (missingDiscards.length || missingReleases.length) {
		const goneIds = [...missingDiscards, ...missingReleases];
		const before = cycle.quantity ?? members.length;
		await BucketCycle.updateOne(
			{ _id: cycle._id },
			{ $pull: { cartridgeIds: { $in: goneIds } }, $set: { quantity: Math.max(0, before - goneIds.length) } }
		);
		if (missingDiscards.length) {
			removalId = removalId ?? generateId();
			const stage = cycle.stage as BucketStage;
			await CartridgeRecord.updateMany(
				{ _id: { $in: missingDiscards } },
				{ $set: { status: 'scrapped', statusUpdatedOn: now.toISOString() }, $push: { notes: { _id: generateId(), body: `Not found in bucket ${cycle.bucketId} during an audit, written off: ${journal}`, phase: 'bucket', author: by, createdAt: now } } }
			);
			await ManualCartridgeRemoval.create({
				_id: generateId(), cartridgeIds: missingDiscards, bucketCycleId: cycle._id, bucketId: cycle.bucketId,
				cartridgeCount: missingDiscards.length, reason: `audit: not in the tub — ${journal}`, journal, operator: by, removedAt: now
			});
			for (const pn of partsAtStage(stage)) {
				await debitScrap(pn, lotFor(cycle.sourceLots, pn), missingDiscards.length, cycle._id, input.user, `audit write-off: ${journal}`, `Audit of ${cycle.bucketId}: ${missingDiscards.length}x ${pn} at ${STAGE_LABELS[stage]} written off (not in the tub) — ${journal}`);
			}
			await logTx({ bucketId: cycle.bucketId, cycleId: cycle._id, type: 'scrap', fromStage: cycle.stage, toStage: cycle.stage, qtyBefore: before, qtyAfter: Math.max(0, before - missingDiscards.length), reason: `audit: ${missingDiscards.length} member(s) not in the tub, written off: ${journal}`, journal, cartridgeIds: missingDiscards, operator: input.user });
		}
		if (missingReleases.length) {
			await CartridgeRecord.updateMany(
				{ _id: { $in: missingReleases } },
				{ $set: { statusUpdatedOn: now.toISOString() }, $push: { notes: { _id: generateId(), body: `Not found in bucket ${cycle.bucketId} during an audit, taken off the pass: ${journal}`, phase: 'bucket', author: by, createdAt: now } } }
			);
			await logTx({ bucketId: cycle.bucketId, cycleId: cycle._id, type: 'unscan', fromStage: cycle.stage, toStage: cycle.stage, qtyBefore: before, qtyAfter: Math.max(0, before - goneIds.length), reason: `audit: ${missingReleases.length} member(s) not in the tub, taken off the pass (still loose): ${journal}`, journal, cartridgeIds: missingReleases, operator: input.user });
		}
	}

	// The audited pass itself: members never scanned stay members; the run is recorded.
	const after = await BucketCycle.findById(cycle._id).select('cartridgeIds quantity').lean() as any;
	const quantityAfter = (after?.cartridgeIds ?? []).length;
	const record = {
		at: now, by, scanned, present, missing, missingActions,
		foreign: [
			...moved.map(m => ({ barcode: m.barcode, action: m.returned ? 'returned' : 'moved', fromCycleId: m.fromCycleId ?? undefined, destinationBucketId: m.destinationBucketId, destinationCycleId: m.destinationCycleId })),
			...discards.map(barcode => ({ barcode, action: 'discarded', fromCycleId: homeOf.get(barcode)?._id ?? undefined }))
		]
	};
	await BucketCycle.updateOne(
		{ _id: cycle._id },
		{
			$set: { quantity: quantityAfter },
			$push: {
				audits: record,
				...(missing.length ? { discrepancies: { type: 'shortfall', qty: missing.length, at: now, note: `audit: ${missing.length} member(s) not found in the tub`
					+ (missingDiscards.length ? `, ${missingDiscards.length} written off` : '')
					+ (missingReleases.length ? `, ${missingReleases.length} taken off the pass` : '')
					+ (missing.length - missingDiscards.length - missingReleases.length > 0 ? `, ${missing.length - missingDiscards.length - missingReleases.length} left on the pass` : '') } } : {})
			}
		}
	);
	await logTx({
		bucketId: cycle.bucketId, cycleId: cycle._id, type: 'audit',
		fromStage: cycle.stage, toStage: cycle.stage,
		qtyBefore: cycle.quantity ?? members.length, qtyAfter: quantityAfter,
		reason: `audit: ${present.length}/${members.length} members found`
			+ (missing.length ? `, ${missing.length} missing` : '')
			+ (missingDiscards.length ? `, ${missingDiscards.length} written off` : '')
			+ (missingReleases.length ? `, ${missingReleases.length} taken off the pass` : '')
			+ (moved.length ? `, ${moved.length} moved out` : '')
			+ (discards.length ? `, ${discards.length} discarded` : ''),
		journal: journal || undefined,
		relatedId: removalId,
		cartridgeIds: scanned,
		operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'AUDIT', input.user, record);

	return {
		cycleId: cycle._id, bucketId: cycle.bucketId, cycleNumber: cycle.cycleNumber,
		expected: members.length, present, missing, moved, discarded: discards,
		missingDiscarded: missingDiscards, missingReleased: missingReleases, quantityAfter
	};
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
	// segments back to their rolls. The roll pull itself (−1 roll) stays:
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
	/**
	 * Per stage: open passes and their member carts. Backed is the exception —
	 * its `cartridges` is EVERY cart at status 'backing', in a bucket or not
	 * (user, 2026-09-25: one category, no separate "no bucket" count). Carts
	 * freed by Move to oven are still 'backing' and still count here.
	 */
	stages: Record<BucketStage, { buckets: number; cartridges: number }>;
	available: number;
	inUse: number;
	quarantined: number;
	retired: number;
}

export async function stageCounts(): Promise<StageCounts> {
	await connectDB();
	const [cycleAgg, bucketAgg, backedTotal] = await Promise.all([
		BucketCycle.aggregate([{ $match: { status: 'open' } }, { $group: { _id: '$stage', buckets: { $sum: 1 }, cartridges: { $sum: '$quantity' } } }]) as any as Promise<any[]>,
		ProductionBucket.aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }]) as any as Promise<any[]>,
		CartridgeRecord.countDocuments({ status: BACKED_STATUS })
	]);
	const stages = Object.fromEntries(BUCKET_STAGES.map(s => [s, { buckets: 0, cartridges: 0 }])) as StageCounts['stages'];
	for (const row of cycleAgg) {
		const stage: unknown = row._id;
		if (isBucketStage(stage)) stages[stage] = { buckets: row.buckets ?? 0, cartridges: row.cartridges ?? 0 };
	}
	stages.backing.cartridges = backedTotal;
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
		// $sort before $group so this rides the { bucketId: 1, createdAt: -1 }
		// index as a distinct scan and takes the first row per bucket. A bare
		// $group/$max was an unconditional collection scan on every board load
		// (perf, 2026-09-25).
		BucketTransaction.aggregate([
			{ $sort: { bucketId: 1, createdAt: -1 } },
			{ $group: { _id: '$bucketId', last: { $first: '$createdAt' } } }
		]) as any as Promise<any[]>
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

// ── manual override (State Change page) ────────────────────────────────────

export interface OverrideInput {
	barcode: string;
	target: string;               // any CartridgeRecord status; bucket stages need destinationBucketId
	destinationBucketId?: string; // bucket (QR or BKT id) whose open pass is at `target`
	reason?: string;
	user: Operator;
}

/**
 * Manual override from /manufacturing/cart-mfg/state-change: move ONE cart to
 * any status while keeping bucket membership honest.
 *   - target is a bucket stage → the cart joins the destination bucket's open
 *     pass (which must already be at that stage), leaving its old pass if any;
 *   - target is anything else → the cart leaves its pass (if it was in one).
 * A pass emptied this way closes like a consumed one (tub back to Available,
 * empty-check armed). No inventory moves — an override is bookkeeping, not
 * production. Unknown barcodes are refused for bucket stages: scanning a cart
 * into a bucket on the board is what debits its shell + label.
 */
export async function overrideCartStage(input: OverrideInput): Promise<{ from: string; to: string; fromCycle: string | null; toCycle: string | null }> {
	await connectDB();
	const barcode = (input.barcode ?? '').trim();
	const target = (input.target ?? '').trim();
	const cart = await CartridgeRecord.findById(barcode).select('_id status bucket').lean() as any;
	if (!cart) throw new BucketError(`${barcode} is not a known cartridge${isBucketStage(target) ? ' — scan it into a bucket on the board instead' : ''}.`, 404);
	const from: string = cart.status ?? 'none';
	const now = new Date();
	const by = { _id: input.user._id, username: input.user.username };
	const why = (input.reason ?? '').trim();
	const note = `Manual override: ${from} → ${target}${why ? `: ${why}` : ''}`;

	const current = await BucketCycle.findOne({ status: 'open', cartridgeIds: barcode }).lean() as any;

	let dest: any = null;
	if (isBucketStage(target)) {
		const destRaw = (input.destinationBucketId ?? '').trim();
		if (!destRaw) throw new BucketError(`Moving to ${STAGE_LABELS[target]} needs a destination bucket whose open pass is at ${STAGE_LABELS[target]}.`);
		const destId = await resolveBucketId(destRaw);
		if (!destId) throw new BucketError(`"${destRaw}" is not a known bucket.`, 404);
		dest = await getOpenCycle(destId);
		if (!dest) throw new BucketError(`Bucket ${destId} has no open pass.`);
		if (dest.stage !== target) throw new BucketError(`${cycleLabel(destId, dest.cycleNumber)} is at ${STAGE_LABELS[dest.stage as BucketStage]}, not ${STAGE_LABELS[target]}.`);
		if (current && current._id === dest._id && from === target) {
			return { from, to: target, fromCycle: current._id, toCycle: dest._id };
		}
	}

	// Leave the old pass (if the destination is a different pass, or a non-bucket status).
	if (current && (!dest || current._id !== dest._id)) {
		const before: number = current.quantity ?? 0;
		const after = Math.max(0, before - 1);
		await BucketCycle.updateOne({ _id: current._id }, { $pull: { cartridgeIds: barcode }, $set: { quantity: after } });
		await logTx({
			bucketId: current.bucketId, cycleId: current._id, type: 'merge_out', fromStage: current.stage, toStage: dest ? dest.stage : current.stage,
			qtyBefore: before, qtyAfter: after, reason: dest ? `override → ${cycleLabel(dest.bucketId, dest.cycleNumber)}${why ? `: ${why}` : ''}` : `override → ${target}${why ? `: ${why}` : ''}`,
			relatedId: dest?._id, cartridgeIds: [barcode], operator: input.user
		});
		if (after === 0) await closeCycle({ ...current, quantity: 0 }, 'consumed', input.user, dest?._id);
	}

	const set: Record<string, unknown> = { status: target, priorStatus: from, statusUpdatedOn: now.toISOString() };
	if (dest) {
		if (!current || current._id !== dest._id) {
			const before: number = dest.quantity ?? 0;
			await BucketCycle.updateOne({ _id: dest._id }, { $addToSet: { cartridgeIds: barcode }, $set: { quantity: before + 1 } });
			await logTx({
				bucketId: dest.bucketId, cycleId: dest._id, type: 'merge_in', fromStage: dest.stage, toStage: dest.stage,
				qtyBefore: before, qtyAfter: before + 1, reason: `override from ${current ? cycleLabel(current.bucketId, current.cycleNumber) : from}${why ? `: ${why}` : ''}`,
				relatedId: current?._id, cartridgeIds: [barcode], operator: input.user
			});
		}
		set.bucket = { bucketId: dest.bucketId, cycleId: dest._id, scannedInAt: cart.bucket?.scannedInAt ?? now, scannedInBy: cart.bucket?.scannedInBy ?? by };
		set['backing.bucketCycleId'] = dest._id;
		set['backing.bucketBarcode'] = dest.bucketId;
	}
	await CartridgeRecord.updateOne(
		{ _id: barcode },
		{ $set: set, $push: { notes: { _id: generateId(), body: note, phase: 'bucket', author: by, createdAt: now } } }
	);
	await audit('cartridge_records', barcode, 'OVERRIDE', input.user, { status: target, cycleId: dest?._id ?? null }, { status: from, cycleId: current?._id ?? null }, why || undefined);
	return { from, to: target, fromCycle: current?._id ?? null, toCycle: dest?._id ?? null };
}

// ── master override (whole bucket) ─────────────────────────────────────────

export const FORCE_TARGETS = BUCKET_STAGES;
export type ForceTarget = (typeof FORCE_TARGETS)[number];
export const FORCE_TARGET_LABELS: Record<ForceTarget, string> = STAGE_LABELS;

export interface ForceBucketInput {
	bucket: string;        // QR sticker or BKT id, scanned
	target: ForceTarget;
	reason: string;        // required
	user: Operator;
}

export interface ForceBucketResult {
	bucketId: string; cycleId: string; cycleNumber: number;
	from: BucketStage; to: ForceTarget; members: number; closed: boolean;
}

/**
 * MASTER OVERRIDE (/manufacturing/cart-mfg/buckets/override, admin only): scan
 * a bucket and put its open pass at ANY phase, bypassing the normal flow —
 * no thermoseal consumption, no "any carts discarded?", no forward-only order.
 * Every member cart's status follows the bucket; the pass stays open at the
 * target (Backed included — wax filling draws from it like any other). Nothing
 * is debited or credited; the ledger row, the cart notes and the audit entry
 * all say MASTER OVERRIDE so it can never be mistaken for production flow.
 */
export async function forceBucketPhase(input: ForceBucketInput): Promise<ForceBucketResult> {
	await connectDB();
	const reason = (input.reason ?? '').trim();
	if (!reason) throw new BucketError('A reason is required for a master override.');
	if (!(FORCE_TARGETS as readonly string[]).includes(input.target)) throw new BucketError(`Unknown phase "${input.target}".`);
	const id = await resolveBucketId(input.bucket);
	if (!id) throw new BucketError(`"${(input.bucket ?? '').trim()}" is not a known bucket.`, 404);
	const cycle = await getOpenCycle(id);
	if (!cycle) throw new BucketError(`Bucket ${id} has no open pass — start one on the board first.`);

	const from = cycle.stage as BucketStage;
	const ids: string[] = cycle.cartridgeIds ?? [];
	const now = new Date();
	const by = { _id: input.user._id, username: input.user.username };
	const label = cycleLabel(id, cycle.cycleNumber);
	const toLabel = FORCE_TARGET_LABELS[input.target];
	const noteBody = `MASTER OVERRIDE ${label}: ${STAGE_LABELS[from]} → ${toLabel}: ${reason}`;
	const cartNote = { _id: generateId(), body: noteBody, phase: 'bucket', author: by, createdAt: now };

	const to = input.target as BucketStage;
	if (to === from) throw new BucketError(`${label} is already at ${STAGE_LABELS[to]}.`);
	const set: Record<string, unknown> = { stage: to, stageEnteredAt: now };
	if (from === 'barcoded') set.openedQty = ids.length; // same rule as advanceCycle: fixed when leaving Barcoded
	await BucketCycle.updateOne({ _id: cycle._id }, { $set: set });
	if (ids.length) {
		const backedStamp = to === BACKED_STAGE
			? { 'backing.recordedAt': now, 'backing.operator': by, 'backing.bucketCycleId': cycle._id, 'backing.bucketBarcode': id }
			: {};
		await CartridgeRecord.updateMany(
			{ _id: { $in: ids } },
			{ $set: { status: to, priorStatus: from, statusUpdatedOn: now.toISOString(), ...backedStamp }, $push: { notes: cartNote } }
		);
	}
	await logTx({
		bucketId: id, cycleId: cycle._id, type: 'advance', fromStage: from, toStage: to,
		qtyBefore: ids.length, qtyAfter: ids.length, reason: `MASTER OVERRIDE (no thermoseal, no discards): ${reason}`,
		cartridgeIds: ids, operator: input.user
	});
	await audit('bucket_cycles', cycle._id, 'FORCE_PHASE', input.user, { stage: to, members: ids.length }, { stage: from }, reason);
	return { bucketId: id, cycleId: cycle._id, cycleNumber: cycle.cycleNumber, from, to: input.target, members: ids.length, closed: false };
}
