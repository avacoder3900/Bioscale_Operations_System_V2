import { redirect, fail } from '@sveltejs/kit';
import { connectDB, WaxFillingRun, ManufacturingSettings, ReceivingLot, AuditLog, generateId } from '$lib/server/db';
import { isAdmin as checkAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

const WAX_TUBE_PART_NUMBER = 'PT-CT-114';
const DEFAULT_MELT_DURATION_MIN = 30;

type MeltState = 'cold' | 'melting' | 'ready';

function mapMeltLot(lot: any, now: number) {
	const melt = lot.waxMelt;
	const readyAtMs = melt?.readyAt ? new Date(melt.readyAt).getTime() : null;
	const confirmed = !!melt?.confirmedMeltedAt;
	const timerReady = readyAtMs !== null && readyAtMs <= now;

	let meltState: MeltState = 'cold';
	if (confirmed || timerReady) meltState = 'ready';
	else if (melt?.startedAt) meltState = 'melting';

	const remainingMin = readyAtMs !== null && !timerReady && !confirmed
		? Math.max(0, Math.ceil((readyAtMs - now) / 60_000))
		: 0;

	return {
		lotId: String(lot._id),
		lotNumber: lot.lotNumber ?? lot.lotId,
		lotBarcode: lot.lotId,
		meltState,
		remainingMin,
		startedAt: melt?.startedAt ? new Date(melt.startedAt).toISOString() : null,
		readyAt: melt?.readyAt ? new Date(melt.readyAt).toISOString() : null,
		confirmedMeltedAt: melt?.confirmedMeltedAt ? new Date(melt.confirmedMeltedAt).toISOString() : null,
		quantity: lot.quantity ?? 0
	};
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	try {
		await connectDB();

		const [settingsDoc, completedRuns, waxLots] = await Promise.all([
			ManufacturingSettings.findById('default').lean(),
			// Runs that have entered the oven (have ovenLocationId set and are completed/storage)
			WaxFillingRun.find({
				status: { $in: ['completed', 'storage', 'Storage'] },
				ovenLocationId: { $exists: true, $ne: null }
			}).sort({ runEndTime: -1 }).limit(50).lean(),
			ReceivingLot.find({
				'part.partNumber': WAX_TUBE_PART_NUMBER,
				status: { $in: ['accepted', 'in_progress'] }
			}).select('_id lotId lotNumber quantity waxMelt').sort({ createdAt: -1 }).lean()
		]);

		const minOvenTimeMin: number = (settingsDoc as any)?.waxFilling?.minOvenTimeMin ?? 60;
		const meltDurationMin: number = (settingsDoc as any)?.waxFilling?.meltDurationMin ?? DEFAULT_MELT_DURATION_MIN;
		const now = Date.now();

		const lots = (completedRuns as any[]).map((r) => {
			const ovenEntryTime = r.runEndTime ? new Date(r.runEndTime) : new Date(r.createdAt);
			const readyAt = new Date(ovenEntryTime.getTime() + minOvenTimeMin * 60 * 1000);
			const readyAtMs = readyAt.getTime();
			const ready = now >= readyAtMs;
			const minutesRemaining = ready ? 0 : Math.ceil((readyAtMs - now) / 60_000);

			return {
				lotId: String(r._id),
				configId: r.robot?.name ?? (r.robot?._id ? String(r.robot._id) : ''),
				ovenEntryTime: ovenEntryTime.toISOString(),
				readyAt: readyAt.toISOString(),
				minutesRemaining,
				ready
			};
		});

		const meltLots = (waxLots as any[]).map((l) => mapMeltLot(l, now));
		const meltCounts = {
			cold: meltLots.filter((l) => l.meltState === 'cold').length,
			melting: meltLots.filter((l) => l.meltState === 'melting').length,
			ready: meltLots.filter((l) => l.meltState === 'ready').length
		};

		return {
			lots,
			minOvenTimeMin,
			meltDurationMin,
			meltLots: JSON.parse(JSON.stringify(meltLots)),
			meltCounts,
			meltNeedsAttention: meltCounts.ready === 0 && meltCounts.cold > 0,
			isAdmin: checkAdmin(locals.user)
		};
	} catch (err) {
		console.error('[WAX-FILLING OVEN-QUEUE] Load error:', err instanceof Error ? err.message : err);
		return {
			lots: [],
			minOvenTimeMin: 60,
			meltDurationMin: DEFAULT_MELT_DURATION_MIN,
			meltLots: [],
			meltCounts: { cold: 0, melting: 0, ready: 0 },
			meltNeedsAttention: false,
			isAdmin: checkAdmin(locals.user)
		};
	}
};

export const actions: Actions = {
	/** Admin override: mark a lot as ready regardless of oven time */
	adminOverride: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!checkAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const reason = data.get('reason') as string;

		if (!reason?.trim()) return fail(400, { error: 'Reason is required for admin override' });

		// Move the oven entry time back to force it to appear ready
		const minOvenTimeMin = 60; // default
		const forcedEntryTime = new Date(Date.now() - (minOvenTimeMin + 1) * 60 * 1000);

		await WaxFillingRun.findByIdAndUpdate(lotId, {
			$set: {
				// Overriding by setting runEndTime to a point in the past that makes it appear ready
				runEndTime: forcedEntryTime,
				'adminOverride.reason': reason,
				'adminOverride.overriddenBy': locals.user._id,
				'adminOverride.overriddenAt': new Date()
			}
		});

		return { success: true };
	},

	/** Start wax melt timer for a ReceivingLot */
	startMelt: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim();
		if (!lotId) return fail(400, { error: 'lotId is required' });

		const lot = await ReceivingLot.findOne({
			$or: [{ _id: lotId }, { lotId }, { lotNumber: lotId }, { bagBarcode: lotId }]
		}).lean() as any;

		if (!lot) return fail(404, { error: `Lot "${lotId}" not found` });
		if (lot.part?.partNumber !== WAX_TUBE_PART_NUMBER) {
			return fail(400, { error: `Lot "${lotId}" is not a wax tube lot` });
		}

		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const meltDurationMin: number = settingsDoc?.waxFilling?.meltDurationMin ?? DEFAULT_MELT_DURATION_MIN;

		const now = new Date();
		const readyAt = new Date(now.getTime() + meltDurationMin * 60 * 1000);

		await ReceivingLot.updateOne(
			{ _id: lot._id },
			{
				$set: {
					'waxMelt.startedAt': now,
					'waxMelt.startedBy': { _id: locals.user._id, username: locals.user.username },
					'waxMelt.readyAt': readyAt
				},
				$unset: { 'waxMelt.confirmedMeltedAt': '', 'waxMelt.confirmedBy': '' }
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'receiving_lots',
			recordId: String(lot._id),
			action: 'UPDATE',
			changedBy: locals.user.username,
			changedAt: now,
			newData: {
				waxMeltStarted: true,
				meltDurationMin,
				readyAt: readyAt.toISOString(),
				lotNumber: lot.lotNumber ?? lot.lotId
			}
		});

		return { success: true, lotId: String(lot._id), readyAt: readyAt.toISOString() };
	},

	/** Manually confirm wax is melted, bypassing the timer */
	confirmMelted: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim();
		if (!lotId) return fail(400, { error: 'lotId is required' });

		const lot = await ReceivingLot.findOne({
			$or: [{ _id: lotId }, { lotId }, { lotNumber: lotId }, { bagBarcode: lotId }]
		}).lean() as any;

		if (!lot) return fail(404, { error: `Lot "${lotId}" not found` });
		if (lot.part?.partNumber !== WAX_TUBE_PART_NUMBER) {
			return fail(400, { error: `Lot "${lotId}" is not a wax tube lot` });
		}

		const now = new Date();

		await ReceivingLot.updateOne(
			{ _id: lot._id },
			{
				$set: {
					'waxMelt.confirmedMeltedAt': now,
					'waxMelt.confirmedBy': { _id: locals.user._id, username: locals.user.username }
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'receiving_lots',
			recordId: String(lot._id),
			action: 'UPDATE',
			changedBy: locals.user.username,
			changedAt: now,
			newData: {
				waxMeltConfirmed: true,
				lotNumber: lot.lotNumber ?? lot.lotId
			}
		});

		return { success: true, lotId: String(lot._id) };
	}
};
