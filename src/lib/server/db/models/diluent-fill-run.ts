import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

const operatorRef = { _id: String, username: String };

/**
 * DiluentFillRun — one OT-2 sample-diluent fill (DILUENT-FILL-1): up to three
 * 15 mL source tubes (A1/A2/A3 of the 15-tube rack), each feeding the heat-frame
 * rack in its own deck row. The third FillKind beside WaxFillingRun and
 * ReagentBatchRecord; the run-lifecycle machinery reads the same fields on all
 * three (status, robot, operator, opentronsRunId, startIntent, pipetteTipState).
 */
const startIntentSchema = new Schema({
	token: String,
	requestedAt: Date,
	requestedBy: { _id: String, username: String },
	line: String, // 'queue' | 'tailnet'
	opentronsRunId: String,
	confirmedAt: Date,
	createArgs: Schema.Types.Mixed,
	resync: Schema.Types.Mixed,
	uncertainAt: Date
}, { _id: false });

const sourceSchema = new Schema({
	well: String,                 // 'A1' | 'A2' | 'A3'
	reagentLotId: String,         // ReagentLot._id — the buffer in the tube
	reagentLotBarcode: String,
	templateName: String,
	tubesPlanned: Number,         // 0–40
	loadedMl: Number,             // what the operator read off the tube
	tubesFilled: Number           // set at finalize
}, { _id: false });

const diluentFillRunSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robot: { _id: String, name: String, side: String },
	operator: operatorRef,

	// Setup → Loading → Running → Completed | Cancelled | Aborted
	status: { type: String, enum: ['Setup', 'Loading', 'Running', 'Completed', 'Cancelled', 'Aborted'] },
	abortReason: String,
	abortPhotoUrl: String,

	pipette: { type: String, enum: ['p1000', 'p300'] },
	diluentVolumeUl: Number,
	tubesPerTrip: Number,
	sources: { type: [sourceSchema], default: [] },
	/** The operator confirmed the deck matches the setup (racks, tubes, tips). */
	deckConfirmedAt: Date,

	setupTimestamp: Date,
	runStartTime: Date,
	runEndTime: Date,
	robotReleasedAt: Date,
	finalizedAt: Date,

	// The lot this run produced (finalize).
	diluentLotId: String,
	diluentLotNumber: String,

	// --- OT-2 integration (same shape as the other two fill records) ---
	protocolParameters: Schema.Types.Mixed,
	opentronsRunId: String,
	opentronsRunFinalStatus: String,
	pipetteTipState: {
		_id: false,
		before: { nextTipIndex: Number, hostname: String, capturedAt: Date },
		after: { nextTipIndex: Number, hostname: String, capturedAt: Date },
		consumed: Number,
		rackRefilledDuringRun: Boolean
	},
	startIntent: { type: startIntentSchema, default: undefined }
}, { timestamps: true });

diluentFillRunSchema.index({ 'robot._id': 1 });
diluentFillRunSchema.index({ status: 1, createdAt: -1 });
// One page-owned run per robot.
diluentFillRunSchema.index(
	{ 'robot._id': 1 },
	{ unique: true, partialFilterExpression: { status: { $in: ['Setup', 'Loading', 'Running'] }, 'robot._id': { $exists: true } }, name: 'robot_active_unique' }
);

applySacredMiddleware(diluentFillRunSchema);

export const DiluentFillRun = mongoose.models.DiluentFillRun || mongoose.model('DiluentFillRun', diluentFillRunSchema, 'diluent_fill_runs');
