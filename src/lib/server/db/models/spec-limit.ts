import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * Per-process per-metric specification limits. Empty by default — operators
 * begin collecting data first, then set limits empirically once the process
 * shows stable baseline. Capability analysis (Cp, Cpk, Pp, Ppk) only runs on
 * metrics where a SpecLimit exists.
 */
const specLimitSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	processType: {
		type: String,
		enum: ['wi-01', 'laser-cut', 'cut-thermoseal', 'cut-top-seal', 'wax',
			'reagent', 'top-seal', 'qa-qc', 'storage', 'shipping', 'general'],
		required: true,
		index: true
	},
	metric: { type: String, required: true, index: true }, // e.g. 'cycleTime', 'fpy', 'scrapRate'
	metricLabel: String, // human-readable
	unit: String, // 'min', '%', '°C', etc.
	LSL: Number, // lower spec limit (null for one-sided)
	USL: Number, // upper spec limit (null for one-sided)
	target: Number,
	cpkMin: { type: Number, default: 1.33 }, // warning threshold
	rationale: String, // why these values — required for regulatory
	// Change control
	effectiveFrom: { type: Date, default: Date.now },
	supersededBy: String, // previous SpecLimit _id if this replaces one
	approvedBy: { _id: String, username: String },
	approvedAt: Date,
	active: { type: Boolean, default: true }
}, { timestamps: true });

specLimitSchema.index({ processType: 1, metric: 1, active: 1 });

export const SpecLimit = mongoose.models.SpecLimit
	|| mongoose.model('SpecLimit', specLimitSchema, 'spec_limits');
