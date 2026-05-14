import mongoose, { Schema } from 'mongoose';

/**
 * ProtocolExecution — research-v2 collection, shared Mongo Atlas.
 *
 * The lab notebook record. Read-only from BIMS. Each execution has:
 * - definitionId → ProtocolDefinition
 * - variantKey → ReagentCatalog.variants[].key
 * - materialsUsed[].inventoryId → ReagentInventory (the input barcodes)
 * - outputs[].barcode → ReagentInventory (the produced barcodes)
 * - experimentId → Experiment (optional)
 *
 * This is the recursion node for trace_reagent_chain (Phase E4) — given a
 * cartridge's reagentChain[].executionId, we can walk back through the
 * materialsUsed inventory to their preparedFromExecutionId, all the way
 * down to stock items.
 */

const protocolExecutionSchema = new Schema(
	{
		_id: String,
		definitionId: String,
		definitionName: String,
		definitionVersion: Number,
		executedBy: String,
		executedByName: String,
		startedAt: String,
		completedAt: String,
		status: String,
		variantKey: String,
		parameterValues: Schema.Types.Mixed,
		materialsUsed: { type: Schema.Types.Mixed, default: [] },
		stepRecords: { type: Schema.Types.Mixed, default: [] },
		outputs: { type: Schema.Types.Mixed, default: [] },
		outputInventoryId: String,
		outputVolume: Number,
		outputConcentration: Number,
		outputNotes: String,
		experimentId: String
	},
	{ strict: false, timestamps: true }
);

export const ProtocolExecution =
	mongoose.models.ProtocolExecution ||
	mongoose.model('ProtocolExecution', protocolExecutionSchema, 'protocol_executions');
