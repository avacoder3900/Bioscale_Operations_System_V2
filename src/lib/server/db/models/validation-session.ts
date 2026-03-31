import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const validationSessionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	type: String, spuId: String, generatedBarcodeId: String,
	status: { type: String, enum: ['pending', 'in_progress', 'running', 'completed', 'failed', 'timed_out'] },
	startedAt: Date, completedAt: Date, userId: String,
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

export const ValidationSession = mongoose.models.ValidationSession || mongoose.model('ValidationSession', validationSessionSchema, 'validation_sessions');
