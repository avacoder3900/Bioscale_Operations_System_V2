import mongoose, { Schema } from 'mongoose';
import { nanoid } from 'nanoid';

/**
 * Research-owned fill lots (brevitest-research-v2 `fill_lots`). A FILL LOT IS ONE REAGENT LOT FILLED ON
 * ONE (Central) DAY, across however many robot decks (Alejandro, 2026-11-09): the fill screen asks for the
 * reagent lot and joins that day's lot, opening it on the first deck. Each run is a deck of the lot
 * (deckNumber, stamped on finalize); the lot number FL-YYYYMMDD-NNN counts the day's lots, not decks.
 *
 * A fill lot may have NO reagent lot (reagentLotSource 'non-calibrated'): most fills happen before a
 * calibrated reagent lot exists — a lot takes several conjugations and chemistry calibrations first.
 * The research app's Curves page can set the reagent lot on it later, which restamps its cartridges.
 */

/** The value the fill screen / connector send in place of a reagent lot id to open a non-calibrated fill lot. */
export const NON_CALIBRATED_REAGENT_LOT = 'non-calibrated';
/** What gets stamped as reagentLotNumber on runs and cartridges filled on a non-calibrated fill lot. */
export const NON_CALIBRATED_LOT_LABEL = 'non-calibrated';
const FillLotSchema = new Schema(
	{
		_id: { type: String },
		fillLotNumber: { type: String },
		name: { type: String },
		status: { type: String },
		assayId: { type: String },
		assayName: { type: String },
		fillDate: { type: String },
		runIds: { type: [String], default: [] },
		reagentLotId: { type: String },
		reagentLotNumber: { type: String },
		reagentLotSource: { type: String },
		createdBy: { type: String }
	},
	{ strict: false, collection: 'fill_lots', timestamps: true }
);

export const FillLot = mongoose.models.FillLot || mongoose.model('FillLot', FillLotSchema);

/** The lab's time zone: an evening fill belongs to that day, not to tomorrow's UTC date. Same as the research app. */
export const FILL_TIME_ZONE = 'America/Chicago';

/** YYYYMMDD of the fill day in the lab's time zone. */
export function fillLotDay(date: Date): string {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone: FILL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
	return `${get('year')}${get('month')}${get('day')}`;
}

/** FL-YYYYMMDD-NNN — the same rule the research app uses. */
export function fillLotNumber(date: Date, seq: number): string {
	return `FL-${fillLotDay(date)}-${String(seq).padStart(3, '0')}`;
}

/** Mongo filter for the open fill lot of a reagent lot (or the non-calibrated one for an assay) on a day. */
export function dayFillLotFilter(day: string, reagent: { reagentLotId: string } | { nonCalibrated: true; assayId: string }) {
	return {
		fillLotNumber: { $regex: `^FL-${day}-` },
		status: 'open',
		...('reagentLotId' in reagent ? { reagentLotId: reagent.reagentLotId } : { reagentLotSource: 'non-calibrated', assayId: reagent.assayId })
	};
}

/**
 * The day's fill lot for a reagent lot: the open one if it exists, else a new one. Two decks starting at
 * once can both miss the lookup; the loser of the race finds the winner's lot on the re-read and drops its own.
 */
export async function findOrOpenDayFillLot(
	reagent: { reagentLotId: string; reagentLotNumber: string; assayId: string } | { nonCalibrated: true; assayId: string },
	opts: { name?: string; actor: string; now?: Date }
): Promise<{ fillLot: Record<string, any>; reused: boolean }> {
	const now = opts.now ?? new Date();
	const day = fillLotDay(now);
	const filter = dayFillLotFilter(day, 'reagentLotId' in reagent ? { reagentLotId: reagent.reagentLotId } : reagent);
	const existing = await FillLot.findOne(filter).sort({ fillLotNumber: 1 }).lean();
	if (existing) return { fillLot: existing as Record<string, any>, reused: true };
	const todays = await FillLot.countDocuments({ fillLotNumber: { $regex: `^FL-${day}-` } });
	const nonCalibrated = !('reagentLotId' in reagent);
	const doc = {
		_id: nanoid(),
		fillLotNumber: fillLotNumber(now, todays + 1),
		name: (opts.name ?? '').trim().slice(0, 200),
		status: 'open',
		assayId: reagent.assayId ?? '',
		assayName: '',
		fillDate: now.toISOString(),
		runIds: [],
		reagentLotId: nonCalibrated ? '' : reagent.reagentLotId,
		reagentLotNumber: nonCalibrated ? '' : reagent.reagentLotNumber,
		reagentLotSource: nonCalibrated ? 'non-calibrated' : 'bims',
		curveSetId: '', curveSetSource: '', assignedBy: '', assignedAt: '', assignmentNote: '', notes: '',
		createdBy: opts.actor
	};
	await FillLot.create(doc);
	const winner = await FillLot.findOne(filter).sort({ fillLotNumber: 1, createdAt: 1 }).lean() as Record<string, any> | null;
	if (winner && winner._id !== doc._id) {
		await FillLot.deleteOne({ _id: doc._id, runIds: { $size: 0 } });
		return { fillLot: winner, reused: true };
	}
	return { fillLot: doc, reused: false };
}
