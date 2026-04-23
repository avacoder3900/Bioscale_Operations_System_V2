import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * A flagged out-of-control point on a control chart. Created when a Nelson /
 * Western Electric rule trips on live data. Workflow: open → acknowledged →
 * investigated → closed with root cause + corrective action.
 */
const spcSignalSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	processType: { type: String, required: true, index: true },
	metric: { type: String, required: true }, // 'cycleTime', 'rejectionRate', etc.
	chartType: {
		type: String,
		enum: ['i_mr', 'x_bar_r', 'p', 'np', 'c', 'u', 'cusum', 'ewma'],
		required: true
	},
	rule: {
		// Nelson rules 1-8
		number: { type: Number, min: 1, max: 8 },
		description: String
	},
	detectedAt: { type: Date, required: true, index: true },
	dataPointValue: Number,
	centerline: Number,
	ucl: Number,
	lcl: Number,
	// Which runs/cartridges are on the offending point
	affectedRunIds: [String],
	affectedCartridgeIds: [String],
	// Workflow
	status: {
		type: String,
		enum: ['open', 'acknowledged', 'investigating', 'closed', 'dismissed'],
		default: 'open',
		index: true
	},
	assignedTo: { _id: String, username: String },
	acknowledgedBy: { _id: String, username: String },
	acknowledgedAt: Date,
	rootCause: String,
	correctiveAction: String,
	linkedFmeaId: String,
	linkedCapaId: String,
	closedBy: { _id: String, username: String },
	closedAt: Date,
	dismissReason: String
}, { timestamps: true });

spcSignalSchema.index({ status: 1, detectedAt: -1 });
spcSignalSchema.index({ processType: 1, metric: 1, status: 1 });

export const SpcSignal = mongoose.models.SpcSignal
	|| mongoose.model('SpcSignal', spcSignalSchema, 'spc_signals');
