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
		source: { type: String, enum: ['reagent_lot', 'stock', 'receiving_lot', 'manual'] },
		sourceId: String,
		label: String,
		barcode: String,
		concentration: Number,
		concentrationUnit: String,
		recordedAt: Date
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
	qcReadings: { type: [qcReadingSchema], default: [] },
	observations: { type: [observationSchema], default: [] },
	note: String,
	flagged: { type: Boolean, default: false }
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

		status: {
			type: String,
			enum: ['in_progress', 'finalized', 'voided'],
			default: 'in_progress'
		},

		parameterValues: { type: [parameterValueSchema], default: [] },
		inputLots: { type: [inputLotSchema], default: [] },
		materialsConsumed: { type: [materialConsumedSchema], default: [] },

		stepEntries: { type: [stepEntrySchema], default: [] },
		postProtocolReadings: { type: [qcReadingSchema], default: [] },

		finalOutputs: {
			concentration: Number,
			concentrationUnit: String,
			volume: Number,
			volumeUnit: String,
			costEstimate: Number,
			notes: String
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

applySacredMiddleware(reagentLotSchema);

export const ReagentLot =
	mongoose.models.ReagentLot ||
	mongoose.model('ReagentLot', reagentLotSchema, 'reagent_lots');
