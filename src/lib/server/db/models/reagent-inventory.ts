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
		preparedFromExecutionId: String, // research-v2 origin (ProtocolExecution._id)
		preparedFromReagentLotId: String, // BIMS origin (ReagentLot._id) — added per unification
		preparedDate: String,
		preparedBy: String,
		// Provenance tag — passively records which app authored this inventory
		// row. Not enforced. 'bims' for rigid lot finalize, 'research-v2' for
		// flexible execution finalize, 'manual' for chemists adding stock
		// arrivals via the inventory page. Allows cross-app reporting later.
		source: { type: String, enum: ['bims', 'research-v2', 'manual'], default: 'manual' },
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

reagentInventorySchema.index({ catalogId: 1 });
reagentInventorySchema.index({ catalogId: 1, variantKey: 1 });
reagentInventorySchema.index({ status: 1 });
reagentInventorySchema.index({ type: 1 });
reagentInventorySchema.index({ preparedFromExecutionId: 1 });
reagentInventorySchema.index({ preparedFromReagentLotId: 1 });
reagentInventorySchema.index({ source: 1 });

export const ReagentInventory =
	mongoose.models.ReagentInventory ||
	mongoose.model('ReagentInventory', reagentInventorySchema, 'reagent_inventory');
