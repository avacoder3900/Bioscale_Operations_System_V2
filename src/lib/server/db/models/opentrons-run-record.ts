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

export const OpentronsRunRecord = mongoose.models.OpentronsRunRecord
	|| mongoose.model('OpentronsRunRecord', opentronsRunRecordSchema, 'opentrons_run_records');
