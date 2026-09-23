/**
 * Bucket board — stage columns + scan rail (BUCKET-SYSTEM_PLAN.md v2 §9.1).
 * Every mutation goes through bucket-service; this file only parses forms,
 * enforces permissions and maps BucketError → fail().
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, ReceivingLot, InventoryTransaction } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import {
	BucketError, BUCKET_STAGES, STAGE_LABELS, IN_OVEN_LABEL, SHELL_PART, LABEL_PART, THERMOSEAL_PART,
	boardData, stageCounts, resolveScan, isBucketStage, changeLog, bucketRegistry,
	startCycle, scanCartIn, unscanCart, advanceCycle, scrapCarts, reportResidual, retireBucket,
	createBucket, replaceBucketSticker, lookupResidualCart
} from '$lib/server/services/bucket-service';
import { thermosealStatus, checkFloor, setThermosealToggles } from '$lib/server/services/thermoseal-service';
import type { Actions, PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

type Op = { _id: string; username: string };
function op(locals: App.Locals): Op {
	return { _id: locals.user!._id, username: locals.user!.username };
}

/** Same per-lot remaining math WI-01 used: lot quantity minus consumption+scrap rows. */
async function availableLots(partNumbers: string[]) {
	const lots = await ReceivingLot.find({
		'part.partNumber': { $in: partNumbers },
		status: { $nin: ['rejected', 'returned'] }
	}).select('lotId part.partNumber quantity').lean() as any[];
	const agg = await InventoryTransaction.aggregate([
		{ $match: { lotId: { $in: lots.map(l => l.lotId) }, transactionType: { $in: ['consumption', 'scrap'] } } },
		{ $group: { _id: '$lotId', total: { $sum: '$quantity' } } }
	]);
	const consumed = new Map((agg as any[]).map(r => [r._id, Math.abs(r.total ?? 0)]));
	const out: Record<string, { lotId: string; remaining: number }[]> = Object.fromEntries(partNumbers.map(p => [p, []]));
	for (const l of lots) {
		const pn = l.part?.partNumber;
		if (!out[pn]) continue;
		const remaining = Math.max(0, Number(l.quantity ?? 0) - (consumed.get(l.lotId) ?? 0));
		if (remaining > 0) out[pn].push({ lotId: l.lotId, remaining });
	}
	for (const pn of partNumbers) out[pn].sort((a, b) => b.remaining - a.remaining);
	return out;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const focusStage = url.searchParams.get('stage') ?? '';
	const q = url.searchParams.get('q') ?? '';

	const [board, counts, lots, scan, log, registry, thermoseal] = await Promise.all([
		boardData(),
		stageCounts(),
		availableLots([SHELL_PART, LABEL_PART, THERMOSEAL_PART]),
		q ? resolveScan(q) : Promise.resolve(null),
		changeLog(150),
		bucketRegistry(),
		// Floor rule runs here too, not only on a roll pull: a shelf that is already
		// below the minimum (receiving, physical count) gets its one restock card +
		// email the next time anyone opens the board. Idempotent.
		checkFloor({ user: op(locals) }).catch(() => null).then(() => thermosealStatus()).catch(() => null)
	]);

	return {
		stages: BUCKET_STAGES.map(s => ({ key: s, label: STAGE_LABELS[s] })),
		inOvenLabel: IN_OVEN_LABEL,
		focusStage: focusStage === 'available' || focusStage === 'in_oven' || isBucketStage(focusStage) ? focusStage : null,
		board,
		counts,
		lots,
		changeLog: log,
		registry,
		thermoseal,
		canAdmin: locals.user.roles.some(r => r.permissions.includes('manufacturing:admin') || r.permissions.includes('admin:full')),
		scan: scan ? JSON.parse(JSON.stringify(scan)) : null,
		scanQuery: q
	};
};

function wrap(key: string, fn: () => Promise<Record<string, unknown>>) {
	return async () => {
		try {
			return await fn();
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { [key]: { error: e.message, code: e.code ?? null } });
			throw e;
		}
	};
}

function codesFrom(raw: FormDataEntryValue | null): string[] {
	return String(raw ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

export const actions: Actions = {
	// Mint a bucket from one scanned QR, inline on the board (Mint New Bucket card).
	mint: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('mint', async () => {
			const r = await createBucket({ qr: String(d.get('qr') ?? ''), user: op(locals) });
			return { mint: { success: true, bucketId: r.bucketId, barcode: r.barcode } };
		})();
	},

	// Replace a damaged sticker, inline on the board. The bucket keeps its id + history.
	relabel: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('relabel', async () => {
			const r = await replaceBucketSticker({ bucketId: String(d.get('bucketId') ?? ''), qr: String(d.get('qr') ?? ''), user: op(locals) });
			return { relabel: { success: true, bucketId: r.bucketId, barcode: r.barcode, previous: r.previous ?? null } };
		})();
	},

	start: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('start', async () => {
			const cycle = await startCycle({
				bucketId: String(d.get('bucketId') ?? ''),
				shellLotId: String(d.get('shellLotId') ?? ''),
				labelLotId: String(d.get('labelLotId') ?? ''),
				emptyConfirmed: d.get('emptyConfirmed') === '1',
				user: op(locals)
			});
			return { start: { success: true, cycleId: cycle._id, bucketId: cycle.bucketId, cycleNumber: cycle.cycleNumber } };
		})();
	},

	// Called via fetch from the Raw panel's scan box (one cart per call) so the
	// rail can keep scanning without a full form round-trip.
	scanIn: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('scanIn', async () => {
			const r = await scanCartIn({ cycleId: String(d.get('cycleId') ?? ''), barcode: String(d.get('barcode') ?? ''), user: op(locals) });
			return { scanIn: { success: true, barcode: r.barcode, quantity: r.cycle?.quantity ?? 0 } };
		})();
	},

	unscan: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('unscan', async () => {
			const cycle = await unscanCart({ cycleId: String(d.get('cycleId') ?? ''), barcode: String(d.get('barcode') ?? ''), user: op(locals) });
			return { unscan: { success: true, barcode: String(d.get('barcode') ?? ''), quantity: cycle?.quantity ?? 0 } };
		})();
	},

	// Development toggle for the thermoseal restock notifications (kanban card + email) — admin.
	thermosealToggles: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		const isAdmin = locals.user.roles.some(r => r.permissions.includes('manufacturing:admin') || r.permissions.includes('admin:full'));
		if (!isAdmin) return fail(403, { thermosealToggles: { error: 'Changing the thermoseal toggles requires manufacturing:admin' } });
		await connectDB();
		const d = await request.formData();
		return wrap('thermosealToggles', async () => {
			const pinRaw = String(d.get('rollsOnHandOverride') ?? '').trim();
			const cfg = await setThermosealToggles({
				notificationsEnabled: d.get('notificationsEnabled') === '1',
				rollsOnHandPinned: d.get('rollsOnHandPinned') === '1',
				rollsOnHandOverride: pinRaw === '' ? undefined : Number(pinRaw),
				user: op(locals)
			});
			return { thermosealToggles: { success: true, notificationsEnabled: cfg.notificationsEnabled, rollsOnHandPinned: cfg.rollsOnHandPinned, rollsOnHandOverride: cfg.rollsOnHandOverride } };
		})();
	},

	advance: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('advance', async () => {
			const r = await advanceCycle({
				cycleId: String(d.get('cycleId') ?? ''),
				thermosealLotId: (d.get('thermosealLotId') as string | null) ?? undefined,
				discardedIds: codesFrom(d.get('discardedIds')),
				discardJournal: (d.get('discardJournal') as string | null) ?? undefined,
				user: op(locals)
			});
			return { advance: {
				success: true, cycleId: r.cycle?._id ?? null, stage: r.cycle?.stage ?? null, discarded: r.discarded, closed: r.closed,
				thermoseal: r.thermoseal ? {
					cm: r.thermoseal.cm, rollsOpened: r.thermoseal.rollsOpened.length,
					alert: r.thermoseal.alert?.below ? { rollsOnHand: r.thermoseal.alert.rollsOnHand, minRolls: r.thermoseal.alert.minRolls, kanbanCreated: r.thermoseal.alert.kanbanCreated, emailSent: r.thermoseal.alert.emailSent } : null
				} : null
			} };
		})();
	},

	scrap: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('scrap', async () => {
			const r = await scrapCarts({
				cycleId: String(d.get('cycleId') ?? ''),
				barcodes: codesFrom(d.get('barcodes')),
				journal: String(d.get('journal') ?? ''),
				user: op(locals)
			});
			return { scrap: { success: true, cycleId: r.cycle?._id ?? null, quantity: r.cycle?.quantity ?? 0, status: r.cycle?.status ?? null, scrapped: r.scrapped.length } };
		})();
	},

	// Leftover flow: fetch per scan — what is this cart, and is it eligible? The
	// board suggests the destination from the answer (v2 §7).
	residualLookup: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:read');
		await connectDB();
		const d = await request.formData();
		const r = await lookupResidualCart(String(d.get('barcode') ?? ''));
		return { residualLookup: r };
	},

	residual: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('residual', async () => {
			const disposition = String(d.get('disposition') ?? '');
			if (disposition !== 'merge' && disposition !== 'scrap') throw new BucketError('Choose a disposition.');
			// moves: JSON [{ barcode, destinationBucketId }] from the board's per-stage pickers.
			let moves: { barcode: string; destinationBucketId: string }[] | undefined;
			const movesRaw = String(d.get('moves') ?? '').trim();
			if (movesRaw) {
				try { moves = JSON.parse(movesRaw); } catch { throw new BucketError('Bad destination list.'); }
				if (!Array.isArray(moves)) throw new BucketError('Bad destination list.');
			}
			const r = await reportResidual({
				bucketId: String(d.get('bucketId') ?? ''),
				barcodes: codesFrom(d.get('barcodes')),
				disposition,
				destinationBucketId: (d.get('destinationBucketId') as string | null) ?? undefined,
				moves,
				journal: (d.get('journal') as string | null) ?? undefined,
				user: op(locals)
			});
			return { residual: { success: true, bucketId: r.bucket?._id ?? null, state: r.bucket?.state ?? null, disposition } };
		})();
	},

	retire: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!locals.user.roles.some(r => r.permissions.includes('manufacturing:admin') || r.permissions.includes('admin:full'))) {
			return fail(403, { retire: { error: 'Retiring a bucket requires manufacturing:admin' } });
		}
		await connectDB();
		const d = await request.formData();
		return wrap('retire', async () => {
			await retireBucket(String(d.get('bucketId') ?? ''), String(d.get('reason') ?? ''), op(locals));
			return { retire: { success: true } };
		})();
	}
};
