/**
 * Thermoseal roll tracking — BUCKET-SYSTEM_PLAN v2 §3.4.
 *
 * PT-CT-112 (thermoseal) is stocked in ROLLS and used by LENGTH:
 *
 *   - every cartridge that enters Unpressed takes `cmPerCartridge` (3.75 cm,
 *     averaged for excess) off the open roll;
 *   - a roll is `rollLengthCm` long (65 m = 6500 cm, ≈ 1733 cartridges);
 *   - when the open roll is used up the next roll is PULLED from inventory —
 *     that pull is the only time the PT-CT-112 inventory count moves (−1);
 *   - the floor rule: at least `minRollsInInventory` (2) rolls must stay on
 *     the shelf. A pull that leaves fewer spawns one kanban restock card
 *     (lead-time warning in the body) and emails the low-inventory list.
 *
 * Consumption happens in bucket-service.advanceCycle (barcoded → unpressed) via
 * consumeThermoseal(); voidCycle credits the length back via creditThermoseal().
 *
 * DEVELOPMENT TOGGLE (ManufacturingSettings.thermoseal.notificationsEnabled,
 * default OFF): the floor rule's kanban card + email. Roll tracking itself —
 * consumption, roll pulls, the board gauge — always runs.
 *
 * DEVELOPMENT PIN (thermoseal.rollsOnHandPinned / rollsOnHandOverride, default
 * pinned at 1): the rolls-on-hand figure the board and the floor rule use.
 * Production WI-01 still withdraws one PT-CT-112 unit per cartridge, so the
 * live count is meaningless in rolls until the systems are unified (PR #60);
 * the user asked for the board to hold at 1 meanwhile. Unpin to follow the
 * live count.
 */
import {
	connectDB, generateId, ManufacturingSettings, PartDefinition, ReceivingLot, ThermosealRoll,
	InventoryTransaction, AuditLog, KanbanTask
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from './inventory-transaction';
import { notifyThermosealLow } from '$lib/server/notifications';
import { ensureThermosealRestockCard } from '$lib/server/kanban/standing';

export const THERMOSEAL_PART = 'PT-CT-112';

export const THERMOSEAL_DEFAULTS = {
	notificationsEnabled: false,
	rollsOnHandPinned: true,
	rollsOnHandOverride: 1,
	cmPerCartridge: 3.75,
	rollLengthCm: 6500,       // 65 m
	minRollsInInventory: 2
} as const;

export interface ThermosealConfig {
	notificationsEnabled: boolean;  // development toggle — restock card + email
	rollsOnHandPinned: boolean;     // development pin — board uses rollsOnHandOverride, not the live count
	rollsOnHandOverride: number;
	cmPerCartridge: number;
	rollLengthCm: number;
	minRollsInInventory: number;
}

interface Operator { _id: string; username: string }

export class ThermosealError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = 'ThermosealError';
		this.status = status;
	}
}

export async function thermosealConfig(): Promise<ThermosealConfig> {
	await connectDB();
	const s = await ManufacturingSettings.findById('default').select('thermoseal').lean() as any;
	const t = s?.thermoseal ?? {};
	const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
	return {
		notificationsEnabled: t.notificationsEnabled === true,
		rollsOnHandPinned: typeof t.rollsOnHandPinned === 'boolean' ? t.rollsOnHandPinned : THERMOSEAL_DEFAULTS.rollsOnHandPinned,
		rollsOnHandOverride: typeof t.rollsOnHandOverride === 'number' && Number.isFinite(t.rollsOnHandOverride) && t.rollsOnHandOverride >= 0
			? Math.floor(t.rollsOnHandOverride) : THERMOSEAL_DEFAULTS.rollsOnHandOverride,
		cmPerCartridge: num(t.cmPerCartridge, THERMOSEAL_DEFAULTS.cmPerCartridge),
		rollLengthCm: num(t.rollLengthCm, THERMOSEAL_DEFAULTS.rollLengthCm),
		minRollsInInventory: num(t.minRollsInInventory, THERMOSEAL_DEFAULTS.minRollsInInventory)
	};
}

/** Development toggles: notifications on/off, and the rolls-on-hand pin (admin). Audited. */
export async function setThermosealToggles(input: {
	notificationsEnabled: boolean;
	rollsOnHandPinned?: boolean;
	rollsOnHandOverride?: number;
	user: Operator;
}): Promise<ThermosealConfig> {
	await connectDB();
	const before = await thermosealConfig();
	const set: Record<string, unknown> = { 'thermoseal.notificationsEnabled': input.notificationsEnabled, updatedAt: new Date() };
	if (typeof input.rollsOnHandPinned === 'boolean') set['thermoseal.rollsOnHandPinned'] = input.rollsOnHandPinned;
	if (typeof input.rollsOnHandOverride === 'number' && Number.isFinite(input.rollsOnHandOverride) && input.rollsOnHandOverride >= 0) {
		set['thermoseal.rollsOnHandOverride'] = Math.floor(input.rollsOnHandOverride);
	}
	await ManufacturingSettings.updateOne({ _id: 'default' }, { $set: set }, { upsert: true });
	const after = await thermosealConfig();
	const pick = (c: ThermosealConfig) => ({ notificationsEnabled: c.notificationsEnabled, rollsOnHandPinned: c.rollsOnHandPinned, rollsOnHandOverride: c.rollsOnHandOverride });
	await AuditLog.create({
		_id: generateId(),
		userId: input.user._id, username: input.user.username,
		action: 'THERMOSEAL_TOGGLES', collectionName: 'manufacturing_settings', documentId: 'default',
		changedAt: new Date(),
		oldData: pick(before),
		newData: pick(after)
	});
	return after;
}

/** Rolls on hand as the bucket system sees it: the development pin while pinned, else the live part count. */
function rollsOnHandFor(cfg: ThermosealConfig, part: any | null): number {
	return cfg.rollsOnHandPinned ? cfg.rollsOnHandOverride : Number(part?.inventoryCount ?? 0);
}

/** cm a bucket of `cartridges` will take when it enters Unpressed. */
export function lengthFor(cartridges: number, cfg: ThermosealConfig): number {
	return Math.round(cartridges * cfg.cmPerCartridge * 100) / 100;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

// ── roll selection ────────────────────────────────────────────────────────

export async function activeRoll(): Promise<any | null> {
	await connectDB();
	return ThermosealRoll.findOne({ status: 'active' }).sort({ openedAt: -1 }).lean();
}

/**
 * The receiving lot the next roll would come from when the operator does not
 * scan one: the oldest accepted PT-CT-112 lot that still has rolls left by
 * the ledger (lot quantity − Σ consumption/scrap rows on that lot).
 */
export async function defaultThermosealLot(): Promise<{ lotId: string; remaining: number } | null> {
	await connectDB();
	const lots = await ReceivingLot.find({ 'part.partNumber': THERMOSEAL_PART, status: { $nin: ['rejected', 'returned'] } })
		.select('lotId quantity createdAt').sort({ createdAt: 1 }).lean() as any[];
	if (lots.length === 0) return null;
	const used = await InventoryTransaction.aggregate([
		{ $match: { lotId: { $in: lots.map(l => l.lotId) }, transactionType: { $in: ['consumption', 'scrap'] } } },
		{ $group: { _id: '$lotId', qty: { $sum: '$quantity' } } }
	]) as any[];
	const usedBy = new Map<string, number>(used.map(u => [String(u._id), Math.abs(Number(u.qty ?? 0))]));
	for (const l of lots) {
		const remaining = Number(l.quantity ?? 0) - (usedBy.get(l.lotId) ?? 0);
		if (remaining > 0) return { lotId: l.lotId, remaining };
	}
	return null;
}

async function thermosealPart(): Promise<any | null> {
	return PartDefinition.findOne({ partNumber: THERMOSEAL_PART })
		.select('_id partNumber name inventoryCount minimumOrderQty leadTimeDays supplier').lean();
}

/**
 * Pull one roll from inventory and open it. The −1 is recorded against the
 * ROLL (manufacturingRunId = roll id), not the bucket pass, so voiding a pass
 * never puts an opened roll back on the shelf. Runs the floor rule after.
 */
export async function openRoll(input: { lotId?: string; user: Operator; forCycleId?: string; cfg?: ThermosealConfig }): Promise<{ roll: any; alert: FloorCheck | null }> {
	await connectDB();
	const cfg = input.cfg ?? await thermosealConfig();
	const stillActive = await ThermosealRoll.findOne({ status: 'active' }).lean() as any;
	if (stillActive && (stillActive.lengthCm - stillActive.consumedCm) > 0.005) {
		throw new ThermosealError(`Roll ${stillActive._id} is still open with ${round2(stillActive.lengthCm - stillActive.consumedCm)} cm left.`);
	}
	if (stillActive) {
		await ThermosealRoll.updateOne({ _id: stillActive._id }, { $set: { status: 'exhausted', exhaustedAt: new Date() } });
	}

	let lotId = (input.lotId ?? '').trim() || undefined;
	if (lotId) {
		const lot = await ReceivingLot.findOne({ lotId, 'part.partNumber': THERMOSEAL_PART }).select('lotId status').lean() as any;
		if (!lot) throw new ThermosealError(`Lot "${lotId}" is not a ${THERMOSEAL_PART} receiving lot.`);
		if (lot.status === 'rejected' || lot.status === 'returned') throw new ThermosealError(`Lot "${lotId}" is ${lot.status} and cannot be used.`);
	} else {
		lotId = (await defaultThermosealLot())?.lotId;
	}

	const rollId = generateId();
	const partId = await resolvePartId(THERMOSEAL_PART);
	const txId = await recordTransaction({
		transactionType: 'consumption',
		partDefinitionId: partId ?? undefined,
		lotId,
		quantity: 1,
		manufacturingStep: 'backing',
		manufacturingRunId: rollId,
		operatorId: input.user._id,
		operatorUsername: input.user.username,
		notes: `Thermoseal roll ${rollId} pulled from inventory and opened at the press${lotId ? ` (lot ${lotId})` : ''}${input.forCycleId ? ` for bucket pass ${input.forCycleId}` : ''}`
	});
	const now = new Date();
	const roll = await ThermosealRoll.create({
		_id: rollId,
		partNumber: THERMOSEAL_PART,
		lotId,
		lengthCm: cfg.rollLengthCm,
		consumedCm: 0,
		status: 'active',
		openedAt: now,
		openedBy: { _id: input.user._id, username: input.user.username },
		openedForCycleId: input.forCycleId,
		inventoryTxId: txId
	});
	await AuditLog.create({
		_id: generateId(),
		userId: input.user._id, username: input.user.username,
		action: 'THERMOSEAL_ROLL_OPENED', collectionName: 'thermoseal_rolls', documentId: rollId,
		changedAt: now, newData: { lotId, lengthCm: cfg.rollLengthCm, forCycleId: input.forCycleId }
	});
	const alert = await checkFloor({ user: input.user, cfg });
	return { roll: roll.toObject(), alert };
}

// ── consumption ───────────────────────────────────────────────────────────

export interface ConsumeResult {
	cm: number;
	segments: { rollId: string; cm: number }[];
	rollsOpened: string[];
	alert: FloorCheck | null;
}

/**
 * Take `cartridges × cmPerCartridge` off the open roll, rolling over onto a
 * freshly pulled roll (and again, for very large buckets) as needed. The
 * first roll ever is pulled here too — nothing is pre-opened.
 */
export async function consumeThermoseal(input: { cartridges: number; user: Operator; cycleId: string; lotId?: string }): Promise<ConsumeResult> {
	await connectDB();
	const cfg = await thermosealConfig();
	let need = lengthFor(input.cartridges, cfg);
	const segments: { rollId: string; cm: number }[] = [];
	const rollsOpened: string[] = [];
	let alert: FloorCheck | null = null;

	while (need > 0.005) {
		let roll = await activeRoll();
		if (!roll || (roll.lengthCm - roll.consumedCm) <= 0.005) {
			const opened = await openRoll({ lotId: input.lotId, user: input.user, forCycleId: input.cycleId, cfg });
			roll = opened.roll;
			rollsOpened.push(roll._id);
			if (opened.alert?.below) alert = opened.alert;
		}
		const left = round2(roll.lengthCm - roll.consumedCm);
		const take = round2(Math.min(left, need));
		const exhausted = take >= left - 0.005;
		await ThermosealRoll.updateOne(
			{ _id: roll._id },
			{ $inc: { consumedCm: take }, ...(exhausted ? { $set: { status: 'exhausted', exhaustedAt: new Date() } } : {}) }
		);
		segments.push({ rollId: roll._id, cm: take });
		need = round2(need - take);
	}
	return { cm: lengthFor(input.cartridges, cfg), segments, rollsOpened, alert };
}

/**
 * Give length back (voidCycle). The roll keeps its status unless it was
 * exhausted and no other roll is open — then it becomes the active roll
 * again. A pulled roll is never returned to inventory here: it was opened.
 */
export async function creditThermoseal(input: { segments: { rollId: string; cm: number }[]; user: Operator; reason: string }): Promise<number> {
	await connectDB();
	let credited = 0;
	for (const seg of input.segments ?? []) {
		if (!(seg.cm > 0)) continue;
		const roll = await ThermosealRoll.findById(seg.rollId).lean() as any;
		if (!roll) continue;
		const consumedCm = round2(Math.max(0, roll.consumedCm - seg.cm));
		const set: Record<string, unknown> = { consumedCm };
		if (roll.status === 'exhausted') {
			const other = await ThermosealRoll.findOne({ status: 'active', _id: { $ne: roll._id } }).lean();
			if (!other) { set.status = 'active'; set.exhaustedAt = undefined; }
		}
		await ThermosealRoll.updateOne({ _id: roll._id }, { $set: set, ...(set.status === 'active' ? { $unset: { exhaustedAt: 1 } } : {}) });
		credited = round2(credited + seg.cm);
	}
	if (credited > 0) {
		await AuditLog.create({
			_id: generateId(),
			userId: input.user._id, username: input.user.username,
			action: 'THERMOSEAL_CREDIT', collectionName: 'thermoseal_rolls', documentId: input.segments[0]?.rollId ?? '',
			changedAt: new Date(), newData: { credited, segments: input.segments }, reason: input.reason
		});
	}
	return credited;
}

// ── floor rule ────────────────────────────────────────────────────────────

// Last time the floor rule actually ran in this process — see checkFloor's throttleMs.
let lastFloorCheckAt = 0;

export interface FloorCheck {
	rollsOnHand: number;
	minRolls: number;
	below: boolean;
	kanbanTaskId: string | null;
	kanbanCreated: boolean;
	emailSent: boolean;
}

/**
 * "At least N rolls in inventory." Called after every pull; safe to call any
 * time (idempotent — one open kanban card per part). Emails only when this
 * call is the one that spawned the card, so a shelf that stays low does not
 * re-mail on every pull; the open card is the standing reminder.
 */
export async function checkFloor(input: {
	user?: Operator;
	cfg?: ThermosealConfig;
	notify?: boolean;
	/**
	 * Skip entirely if the rule already ran this recently in this process. The
	 * bucket board passes this: the floor rule is a backstop that wants to run on
	 * a page open, not on every board refresh while someone scans carts in.
	 * A roll pull omits it — that check must always run.
	 */
	throttleMs?: number;
}): Promise<FloorCheck | null> {
	if (input.throttleMs && Date.now() - lastFloorCheckAt < input.throttleMs) return null;
	lastFloorCheckAt = Date.now();
	await connectDB();
	const cfg = input.cfg ?? await thermosealConfig();
	const part = await thermosealPart();
	if (!part) return null;
	const rollsOnHand = rollsOnHandFor(cfg, part);
	const below = rollsOnHand < cfg.minRollsInInventory;
	const result: FloorCheck = { rollsOnHand, minRolls: cfg.minRollsInInventory, below, kanbanTaskId: null, kanbanCreated: false, emailSent: false };
	// Development toggle: no card, no email until notifications are switched on.
	if (!below || input.notify === false || !cfg.notificationsEnabled) return result;

	try {
		const card = await ensureThermosealRestockCard({
			partId: String(part._id), partNumber: part.partNumber, name: part.name,
			rollsOnHand, minRolls: cfg.minRollsInInventory,
			leadTimeDays: part.leadTimeDays ?? null, supplier: part.supplier ?? null, minimumOrderQty: part.minimumOrderQty ?? null
		});
		result.kanbanTaskId = card.taskId;
		result.kanbanCreated = card.created;
	} catch (e) {
		console.error('[thermoseal] restock card failed:', e);
	}
	if (result.kanbanCreated) {
		const mail = await notifyThermosealLow({
			partId: String(part._id), partNumber: part.partNumber, name: part.name,
			rollsOnHand, minRolls: cfg.minRollsInInventory,
			leadTimeDays: part.leadTimeDays ?? null, supplier: part.supplier ?? null,
			kanbanTaskId: result.kanbanTaskId, pulledBy: input.user?.username ?? null
		});
		result.emailSent = !!mail?.sent;
	}
	return result;
}

// ── status for the board ──────────────────────────────────────────────────

export interface ThermosealStatus {
	config: ThermosealConfig;
	roll: {
		id: string;
		lotId: string | null;
		lengthCm: number;
		consumedCm: number;
		remainingCm: number;
		remainingCartridges: number;   // floor(remaining / cmPerCartridge)
		openedAt: string | null;
		openedBy: string | null;
	} | null;
	rollsOnHand: number;
	rollsOnHandLive: number;   // the raw PT-CT-112 count (what production is doing to it)
	minRolls: number;
	belowFloor: boolean;
	nextLot: { lotId: string; remaining: number } | null;
	openRestockTaskId: string | null;
	rollsExhausted: number;
}

export async function thermosealStatus(): Promise<ThermosealStatus> {
	await connectDB();
	const cfg = await thermosealConfig();
	const [roll, part, nextLot, exhausted] = await Promise.all([
		activeRoll(), thermosealPart(), defaultThermosealLot(),
		ThermosealRoll.countDocuments({ status: 'exhausted' })
	]);
	let openRestockTaskId: string | null = null;
	if (part) {
		const open = await KanbanTask.findOne({ sourceRef: `thermoseal-restock:${part._id}`, status: { $ne: 'done' }, archived: false }).select('_id').lean() as any;
		openRestockTaskId = open?._id ?? null;
	}
	const rollsOnHand = rollsOnHandFor(cfg, part);
	const rollsOnHandLive = Number(part?.inventoryCount ?? 0);
	const remainingCm = roll ? round2(roll.lengthCm - roll.consumedCm) : 0;
	return {
		config: cfg,
		roll: roll ? {
			id: roll._id, lotId: roll.lotId ?? null, lengthCm: roll.lengthCm, consumedCm: round2(roll.consumedCm),
			remainingCm, remainingCartridges: Math.floor(remainingCm / cfg.cmPerCartridge),
			openedAt: roll.openedAt ? new Date(roll.openedAt).toISOString() : null,
			openedBy: roll.openedBy?.username ?? null
		} : null,
		rollsOnHand,
		rollsOnHandLive,
		minRolls: cfg.minRollsInInventory,
		belowFloor: rollsOnHand < cfg.minRollsInInventory,
		nextLot,
		openRestockTaskId,
		rollsExhausted: exhausted
	};
}
