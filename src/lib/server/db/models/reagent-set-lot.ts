import mongoose, { Schema } from 'mongoose';

/**
 * Research-owned reagent lots (brevitest-research-v2 `reagent_set_lots`): the bundle
 * of inventory barcodes (qd630, qd480, beads, buffer, wash, elution) filled into
 * cartridges. BIMS only READS this collection: the fill screen picks a lot and
 * stamps its id on the run and on every cartridge. Never written here.
 */
const ReagentSetLotSchema = new Schema(
	{
		_id: { type: String },
		lotNumber: { type: String },
		name: { type: String },
		assayId: { type: String },
		components: { type: [Schema.Types.Mixed], default: [] },
		compatibilityKey: { type: String },
		status: { type: String },
		createdBy: { type: String }
	},
	{ strict: false, collection: 'reagent_set_lots', timestamps: true }
);

export const ReagentSetLot =
	mongoose.models.ReagentSetLot || mongoose.model('ReagentSetLot', ReagentSetLotSchema);
