import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

const operatorRef = { _id: String, username: String };
const correctionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fieldPath: String, previousValue: Schema.Types.Mixed, correctedValue: Schema.Types.Mixed,
	reason: String, correctedBy: operatorRef, correctedAt: Date, approvedBy: operatorRef, approvedAt: Date
}, { _id: false });

const reagentBatchRecordSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	runNumber: String,
	robot: { _id: String, name: String, side: String },
	assayType: { _id: String, name: String, skuCode: String },
	// Research runs bypass the assay-required gate. When true, assayType stays
	// null and downstream fields that would be populated from the assay are
	// left blank. The cartridge flow still completes end-to-end.
	isResearch: { type: Boolean, default: false },
	operator: operatorRef,
	deckId: String,

	tubeRecords: [{
		_id: false,
		wellPosition: Number, reagentName: String, sourceLotId: String,
		transferTubeId: String, preparedAt: Date
	}],

	setupTimestamp: Date, runStartTime: Date, runEndTime: Date,
	// Set when the OT-2 finishes (completeRunFilling). Once present, the run
	// no longer locks the robot — operators can start a new run while the
	// post-OT-2 steps (inspection/sealing/storage) continue on Opentron Control.
	robotReleasedAt: Date,
	// Tray the cartridges sit on between Inspection and Top Sealing. Not a
	// fridge/oven location — purely a holding surface.
	trayId: String,
	// status stores the current UI workflow stage or terminal state
	status: {
		type: String,
		enum: [
			// Legacy values (keep for existing data)
			'setup', 'running', 'completed', 'aborted', 'voided',
			// Full workflow stages. 'Inspection' (REAGENT-INSPECT-AFTER-TOPSEAL) and
			// 'Top Sealing' / 'Storage' (REAGENT-TOPSEAL-IMPLICIT, 2026-08-19) are
			// retired — kept so historical rows validate. Live flow: Setup →
			// Loading → Running → Completed.
			'Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage',
			// Terminal states (PascalCase)
			'Completed', 'Aborted', 'Cancelled'
		]
	},
	abortReason: String, abortPhotoUrl: String,

	cartridgesFilled: [{
		_id: false,
		cartridgeId: String, deckPosition: Number,
		inspectionStatus: { type: String, enum: ['Accepted', 'Rejected', 'Pending', 'QA/QC'] },
		inspectionReason: String, inspectedBy: operatorRef, inspectedAt: Date,
		topSealBatchId: String, storageLocation: String, storedAt: Date
	}],
	cartridgeCount: Number,

	// Top seal batches (supports multiple batches per run)
	sealBatches: [{
		_id: { type: String, default: () => generateId() },
		topSealLotId: String, operator: operatorRef,
		firstScanTime: Date, completionTime: Date, durationSeconds: Number,
		cartridgeIds: [String], status: { type: String, default: 'in_progress' }
	}],

	// Legacy single topSeal for backward compat
	topSeal: {
		_id: { type: String, default: () => generateId() },
		topSealLotId: String, operator: operatorRef,
		firstScanTime: Date, completionTime: Date, durationSeconds: Number,
		cartridgeCount: Number, status: String
	},

	qcRelease: {
		shippingLotId: String,
		qaqcCartridgeIds: [String],
		testResult: { type: String, enum: ['pass', 'fail', 'pending', 'testing'] },
		testedBy: operatorRef, testedAt: Date, notes: String,
		createdAt: Date
	},

	// Free-text operator notes attached to the run. Append-only metadata —
	// never gates state transitions. Mirrored to each cartridge's notes[]
	// at write time so the same note appears on the run AND on every
	// cartridge in the run. phase tags the workflow point (e.g. 'reagent_prep').
	notes: [{
		_id: { type: String, default: () => generateId() },
		body: String,
		phase: String,
		author: operatorRef,
		createdAt: Date
	}],

	finalizedAt: Date, voidedAt: Date, voidReason: String,
	corrections: [correctionSchema],

	// --- OT-2 integration (the parameter set + linkage to the executed run) ---
	// Captured when the operator hits "Start Run" on this reagent batch.
	// Mixed because protocol parameter schemas evolve; the reagent protocol's
	// add_parameters() is the source of truth for valid keys.
	protocolParameters: Schema.Types.Mixed,
	// Operator's planned cartridge count, saved at the params step BEFORE any
	// scan — the scanner sweep clamps its default walk to this so a lost browser
	// tab state can no longer make it sweep all 24 positions on a partial fill.
	plannedCartridgeCount: Number,
	plannedCountAt: Date,
	// OT-2 run id (UUID, returned by `POST /runs` on the robot). Lets us
	// pull commands/errors from the robot for this specific run.
	opentronsRunId: String,
	// Terminal status of the OT-2 .py (succeeded/failed/stopped), stamped when
	// the protocol lands terminal. Lets the page show the deck-removal
	// confirmation only after the run completes, on reload too.
	opentronsRunFinalStatus: String,
	// Persistent tip tracker snapshot — captured pre-run from the robot's
	// /data/tip_tracker_reagent_<hostname>.json file and stamped again
	// post-run. `consumed` is `after.nextTipIndex - before.nextTipIndex`
	// (or (96 - before) + after if the rack was refilled mid-run).
	pipetteTipState: {
		_id: false,
		before: { nextTipIndex: Number, hostname: String, capturedAt: Date },
		after:  { nextTipIndex: Number, hostname: String, capturedAt: Date },
		consumed: Number,
		rackRefilledDuringRun: Boolean
	}
}, { timestamps: true });

reagentBatchRecordSchema.index({ 'assayType._id': 1, status: 1 });
reagentBatchRecordSchema.index({ 'operator._id': 1 });
reagentBatchRecordSchema.index({ 'robot._id': 1 });
reagentBatchRecordSchema.index({ status: 1, createdAt: -1 });
reagentBatchRecordSchema.index({ 'cartridgesFilled.cartridgeId': 1 });

// Robot + deck are held through the filling-page-owned stages only.
// REAGENT-TOPSEAL-IMPLICIT: 'Top Sealing' / 'Storage' are retired (a run ends at
// Running → Completed), so in practice the two windows below are the same. The
// retired values are deliberately KEPT in the partialFilterExpression — changing
// it would make Mongoose's index sync conflict with the existing
// `tray_active_unique` index in Atlas (same name, different options). They are
// inert: nothing writes those statuses any more.
const REAGENT_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Inspection',
	'setup', 'loading', 'running', 'inspection'];
const REAGENT_NON_TERMINAL = ['Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage',
	'setup', 'loading', 'running', 'inspection', 'top_sealing', 'storage'];

reagentBatchRecordSchema.index(
	{ 'robot._id': 1 },
	{ unique: true, partialFilterExpression: { status: { $in: REAGENT_PAGE_OWNED }, 'robot._id': { $exists: true } }, name: 'robot_active_unique' }
);
reagentBatchRecordSchema.index(
	{ deckId: 1 },
	{ unique: true, partialFilterExpression: { status: { $in: REAGENT_PAGE_OWNED }, deckId: { $exists: true } }, name: 'deck_active_unique' }
);
reagentBatchRecordSchema.index(
	{ trayId: 1 },
	{ unique: true, partialFilterExpression: { status: { $in: REAGENT_NON_TERMINAL }, trayId: { $exists: true } }, name: 'tray_active_unique' }
);

applySacredMiddleware(reagentBatchRecordSchema);

export const ReagentBatchRecord = mongoose.models.ReagentBatchRecord || mongoose.model('ReagentBatchRecord', reagentBatchRecordSchema, 'reagent_batch_records');
