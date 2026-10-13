import mongoose, { Schema } from 'mongoose';

/**
 * Research-owned fill lots (brevitest-research-v2 `fill_lots`): a person opens one on a reagent
 * lot (FL-YYYYMMDD-NNN); the fill screen offers the open ones, defaults to the one used last,
 * and stamps the pick on the run and on every cartridge it fills. BIMS creates lots here only
 * through the fill screen's "new fill lot" action and appends run ids on finalize.
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

/** FL-YYYYMMDD-NNN — the same rule the research app uses. */
export function fillLotNumber(date: Date, seq: number): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, '0');
	const d = String(date.getUTCDate()).padStart(2, '0');
	return `FL-${y}${m}${d}-${String(seq).padStart(3, '0')}`;
}
