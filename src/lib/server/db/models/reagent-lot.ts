import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

/**
 * ReagentLot — one execution of a ReagentProtocolTemplate. The lot tube the
 * chemist produces. Stays fully editable until finalizedAt is set (sacred
 * middleware then blocks mutations except through corrections[]).
 *
 * No state gating beyond finalization: out-of-range QC readings raise flags
 * but never block the operator. Notes and observations are editable up to
 * finalize. Cartridge tie-in (decrementing remainingVolume on cartridge runs)
 * is intentionally deferred — see remainingVolume note below.
 */

const operatorRef = { _id: String, username: String };

const parameterValueSchema = new Schema(
	{
		key: { type: String, required: true },
		value: Schema.Types.Mixed,
		unit: String
	},
	{ _id: false }
);

const inputLotSchema = new Schema(
	{
		materialKey: String,
		// 'reagent_lot' = upstream BIMS ReagentLot (direct denormalized pointer).
		// 'reagent_inventory' = upstream inventory tube barcode (could resolve
		//   to either a BIMS lot via preparedFromReagentLotId or a research-v2
		//   execution via preparedFromExecutionId — buildLineage handles both).
		// 'stock' = stock material scanned (vendor barcode, no upstream prep).
		// 'receiving_lot' = inbound receiving lot record.
		// 'manual' = ad-hoc entry, no traceable source.
		source: {
			type: String,
			enum: ['reagent_lot', 'reagent_inventory', 'stock', 'receiving_lot', 'manual']
		},
		sourceId: String,
		label: String,
		barcode: String,
		concentration: Number,
		concentrationUnit: String,
		recordedAt: Date
	},
	{ _id: false }
);

// Material that was actually scanned/consumed during execution. Distinct from
// inputLots[] which captures parent-lot lineage (often a subset of materials).
// materialsUsed[] is comprehensive — every barcode the operator scanned into a
// step, with the snapshot of inventory state at scan time.
const materialUsedSchema = new Schema(
	{
		key: String, // materialKey from template
		inventoryId: String, // ReagentInventory._id (barcode) that was scanned
		catalogName: String, // denormalized for display
		actualConcentration: Number,
		amountUsed: Number,
		unit: String,
		scannedAt: Date,
		scannedBy: { _id: String, username: String }
	},
	{ _id: false }
);

const materialConsumedSchema = new Schema(
	{
		materialKey: String,
		label: String,
		amountUsed: Number,
		unit: String,
		costEstimate: Number
	},
	{ _id: false }
);

const qcReadingSchema = new Schema(
	{
		checkpointKey: { type: String, required: true },
		label: String,
		value: Schema.Types.Mixed,
		unit: String,
		flag: {
			type: String,
			enum: ['in-range', 'out-of-range', 'unmeasured', 'qualitative'],
			default: 'unmeasured'
		},
		note: String,
		enteredBy: operatorRef,
		enteredAt: Date
	},
	{ _id: false }
);

// Subdocs that need trackable IDs (edit/delete by _id): no `_id: false`
// schema option — the manual _id field takes over from Mongoose's default
// ObjectId auto-add. Per CLAUDE.md pitfall guidance.
const observationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	promptKey: String,
	body: String,
	concern: { type: Boolean, default: false },
	enteredBy: operatorRef,
	enteredAt: Date,
	updatedAt: Date
});

const stepEntrySchema = new Schema({
	_id: { type: String, default: () => generateId() },
	stepKey: { type: String, required: true },
	stepNumber: Number,
	stepTitle: String,
	startedAt: Date,
	completedAt: Date,
	completedBy: operatorRef,
	qcReadings: { type: [qcReadingSchema], default: [] },
	observations: { type: [observationSchema], default: [] },
	note: String,
	flagged: { type: Boolean, default: false },
	// Skipped step capture (carried over from research-v2 ProtocolExecution).
	// When a step is legitimately skipped (e.g., "pellet already clean, second
	// wash not needed"), record skipped=true + skipReason for the lineage.
	skipped: { type: Boolean, default: false },
	skipReason: String,
	actualVolumes: { type: Schema.Types.Mixed, default: undefined }
});

const lotNoteSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	body: String,
	author: operatorRef,
	createdAt: Date,
	updatedAt: Date
});

const flagSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	source: {
		type: String,
		enum: ['qc', 'post-protocol', 'observation', 'manual']
	},
	stepKey: String,
	checkpointKey: String,
	reason: String,
	createdAt: Date
});

const correctionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fieldPath: String,
	previousValue: Schema.Types.Mixed,
	correctedValue: Schema.Types.Mixed,
	reason: String,
	correctedBy: operatorRef,
	correctedAt: Date
});

const reagentLotSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		lotBarcode: { type: String, required: true },

		templateId: { type: String, required: true },
		templateSlug: String,
		templateName: String,
		templateVersion: Number,

		operator: operatorRef,
		startedAt: { type: Date, default: () => new Date() },
		finalizedAt: Date,
		voidedAt: Date,
		voidReason: String,
		deletedAt: Date,
		deletedBy: operatorRef,
		deleteReason: String,

		status: {
			type: String,
			enum: ['in_progress', 'finalized', 'voided', 'deleted'],
			default: 'in_progress'
		},

		parameterValues: { type: [parameterValueSchema], default: [] },
		inputLots: { type: [inputLotSchema], default: [] },
		materialsConsumed: { type: [materialConsumedSchema], default: [] },
		// Comprehensive scan log — every barcode scanned into any step during
		// the run. inputLots[] is the curated lineage; materialsUsed[] is the
		// raw activity log. Both useful, neither subsumes the other.
		materialsUsed: { type: [materialUsedSchema], default: [] },

		stepEntries: { type: [stepEntrySchema], default: [] },
		postProtocolReadings: { type: [qcReadingSchema], default: [] },

		// Lot-level summary the chemist records before finalize. Kept singular
		// for back-compat with the 19 finalized lots that populated it under
		// the prior schema. NEW per-tube barcoded outputs go in outputs[] below.
		finalOutputs: {
			concentration: Number,
			concentrationUnit: String,
			volume: Number,
			volumeUnit: String,
			costEstimate: Number,
			notes: String
		},

		// Per-tube output records, populated at finalize. One entry per
		// physical tube the chemist labelled and scanned. Each entry triggers
		// creation of a corresponding ReagentInventory row at finalize time.
		// outputSpecKey points back to template.outputSpecs[].key when the
		// template declared multiple output kinds (e.g., conjugate vs
		// supernatant); empty when the template has only outputSpec.
		outputs: {
			type: [
				new Schema(
					{
						barcode: { type: String, required: true },
						outputSpecKey: String,
						catalogId: String, // copied from template at finalize for audit
						concentration: Number,
						concentrationUnit: String,
						volume: Number,
						volumeUnit: String,
						notes: String,
						createdAt: { type: Date, default: () => new Date() }
					},
					{ _id: false }
				)
			],
			default: []
		},

		lotNotes: { type: [lotNoteSchema], default: [] },
		finalObservations: String,
		flags: { type: [flagSchema], default: [] },

		// TODO: cartridge-fill consumption decrement.
		// When the reagent-filling page is wired to subtract volume per run,
		// these fields track what's left in the lot tube. Aliquoting into
		// smaller tubes still attributes consumption back to the parent lot.
		// Left as-is for now per user direction 2026-05-14.
		remainingVolume: Number,
		remainingVolumeUnit: String,

		corrections: { type: [correctionSchema], default: [] }
	},
	{ timestamps: true }
);

reagentLotSchema.index({ lotBarcode: 1 }, { unique: true });
reagentLotSchema.index({ templateId: 1, status: 1 });
reagentLotSchema.index({ templateSlug: 1, status: 1, createdAt: -1 });
reagentLotSchema.index({ 'operator._id': 1 });
reagentLotSchema.index({ status: 1, createdAt: -1 });
reagentLotSchema.index({ 'outputs.barcode': 1 });
reagentLotSchema.index({ 'inputLots.sourceId': 1 });

applySacredMiddleware(reagentLotSchema);

export const ReagentLot =
	mongoose.models.ReagentLot ||
	mongoose.model('ReagentLot', reagentLotSchema, 'reagent_lots');
