import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const validationSessionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	type: String, spuId: String, generatedBarcodeId: String,
	status: { type: String, enum: ['pending', 'in_progress', 'completed', 'failed'] },
	startedAt: Date, completedAt: Date, userId: String,
	results: [{
		_id: { type: String, default: () => generateId() },
		testType: String, rawData: Schema.Types.Mixed, processedData: Schema.Types.Mixed,
		passed: Boolean, notes: String, createdAt: Date
	}],
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

export const ValidationSession = mongoose.models.ValidationSession || mongoose.model('ValidationSession', validationSessionSchema, 'validation_sessions');
