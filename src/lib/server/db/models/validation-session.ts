import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const validationSessionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	type: String, spuId: String, generatedBarcodeId: String,
	// VALIDATION-05: set when the session was created from a validation run.
	runId: String,
	status: { type: String, enum: ['pending', 'in_progress', 'running', 'completed', 'failed', 'timed_out'] },
	// startedAt/completedAt are when BIMS RECORDED the session — for magnetometer
	// that is when the Particle variable was polled, which can be long after the
	// test itself if the variable was stale.
	startedAt: Date, completedAt: Date, userId: String,
	// When the test actually ran on the device, parsed out of rawData. Null when the
	// payload carries no timestamp (legacy format) — never silently backfilled with
	// the poll time. See $lib/server/magnetometer-time.
	testRanAt: Date,
	spuUdi: String, particleDeviceId: String,
	rawData: Schema.Types.Mixed,
	magResults: Schema.Types.Mixed,
	overallPassed: Boolean,
	failureReasons: [String],
	criteriaUsed: Schema.Types.Mixed,
	barcode: String,
	results: [{
		_id: { type: String, default: () => generateId() },
		testType: String, rawData: Schema.Types.Mixed, processedData: Schema.Types.Mixed,
		passed: Boolean, notes: String, createdAt: Date
	}],
	override: {
		type: {
			by: { _id: String, username: String },
			at: Date,
			reason: String,
			originalResult: {
				overallPassed: Boolean,
				failureReasons: [String],
				status: String
			}
		},
		default: null,
		_id: false
	},
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

// The magnetometer poll endpoint and history pages had ZERO indexes to work
// with — every poll was a full collection scan (Atlas alert, 2026-07-31).
validationSessionSchema.index({ spuId: 1, startedAt: -1 });
validationSessionSchema.index({ type: 1, startedAt: -1 });

export const ValidationSession = mongoose.models.ValidationSession || mongoose.model('ValidationSession', validationSessionSchema, 'validation_sessions');
