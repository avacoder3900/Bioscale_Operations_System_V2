import mongoose, { Schema } from 'mongoose';

/**
 * ReagentInventory — research-v2 collection, shared Mongo Atlas.
 *
 * Each document is ONE physical reagent item; _id is the UUID barcode on the
 * physical item. preparedFromExecutionId links prepared reagents back to the
 * ProtocolExecution that produced them — that's the recursion anchor for
 * trace_reagent_chain (Phase E4).
 *
 * variantKey ties an inventory item to a specific catalog variant. Inventory
 * rollups MUST group by (catalogId, variantKey) — different antibody clones
 * stay in separate buckets per DOMAIN-26-REAGENT-VARIANTS.
 */

const inspectionSchema = new Schema(
	{
		date: String,
		type: String,
		measuredValue: Number,
		measuredUnit: String,
		notes: String,
		inspectedBy: String
	},
	{ _id: false }
);

const reagentInventorySchema = new Schema(
	{
		_id: String,
		catalogId: String,
		catalogName: String,
		variantKey: String,
		type: String,
		manufacturerLotId: String,
		catalogNumber: String,
		manufacturer: String,
		receivedDate: String,
		expirationDate: String,
		preparedFromExecutionId: String,
		preparedDate: String,
		preparedBy: String,
		concentration: Number,
		concentrationUnit: String,
		volume: Number,
		initialVolume: Number,
		location: String,
		status: String,
		inspections: { type: [inspectionSchema], default: [] },
		notes: String,
		enteredBy: String,
		enteredDate: String
	},
	{ strict: false, timestamps: true }
);

export const ReagentInventory =
	mongoose.models.ReagentInventory ||
	mongoose.model('ReagentInventory', reagentInventorySchema, 'reagent_inventory');
