import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const opentronsRunRecordSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Link to BIMS manufacturing
	manufacturingRunId: String,
	manufacturingRunType: { type: String, enum: ['wax-filling', 'reagent-filling'] },

	// Link to OT-2
	robotId: { type: String, ref: 'OpentronsRobot' },
	robotName: String,
	opentronsRunId: String,
	opentronsProtocolId: String,

	// Runtime parameters sent to robot
	runtimeParameters: Schema.Types.Mixed,

	// Labware offsets applied
	labwareOffsets: [{
		_id: false,
		definitionUri: String,
		slotName: String,
		vector: {
			x: Number,
			y: Number,
			z: Number,
		},
	}],

	// Deck geometry provenance (DECK-CAL). Which physical deck the operator
	// selected, which labware definition that deck is bound to, and the exact
	// version + content hash of the geometry in play. Without this, "the tip went
	// to the wrong place" is unanswerable after the fact — the definition is
	// edited in place, so by the time anyone investigates, the coordinates that
	// ran no longer exist anywhere.
	deckGeometry: {
		_id: false,
		deckId: String,
		deckLoadName: String,
		particleDeviceId: String,
		definitionVersion: Number,
		definitionHash: String,
		wellCount: Number,
		warning: String
	},

	// Run lifecycle
	status: {
		type: String,
		enum: ['created', 'running', 'paused', 'succeeded', 'failed', 'stopped', 'error'],
		default: 'created',
	},

	// Timestamps from OT-2
	robotCreatedAt: Date,
	robotStartedAt: Date,
	robotCompletedAt: Date,

	// Error tracking
	errors: [{
		_id: false,
		errorType: String,
		detail: String,
		createdAt: Date,
	}],

	// Command summary
	totalCommands: Number,
	completedCommands: Number,

	// Operator
	startedBy: String,

	// Cartridges involved
	cartridgeIds: [String],
}, { timestamps: true });

opentronsRunRecordSchema.index({ manufacturingRunId: 1 });
opentronsRunRecordSchema.index({ robotId: 1, status: 1 });
opentronsRunRecordSchema.index({ opentronsRunId: 1 }, { unique: true, sparse: true });
// The health-poller singleton filters by status alone every 15s — without a
// status-prefix index that was a permanent COLLSCAN (Atlas alert, 2026-07-31).
opentronsRunRecordSchema.index({ status: 1 });

export const OpentronsRunRecord = mongoose.models.OpentronsRunRecord
	|| mongoose.model('OpentronsRunRecord', opentronsRunRecordSchema, 'opentrons_run_records');
