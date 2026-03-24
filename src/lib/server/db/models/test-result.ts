import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const testResultSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	dataFormatCode: String, cartridgeUuid: String, assayId: String, deviceId: String,
	startTime: Number, duration: Number,
	astep: Number, atime: Number, again: Number,
	numberOfReadings: Number, baselineScans: Number, testScans: Number,
	checksum: Number, rawRecord: Schema.Types.Buffer,
	status: { type: String, enum: ['uploaded', 'processing', 'completed', 'failed'] },
	metadata: Schema.Types.Mixed,
	readings: [{
		_id: false,
		readingNumber: Number, channel: { type: String, enum: ['A', 'B', 'C'] },
		position: Number, temperature: Number, laserOutput: Number, timestampMs: Number,
		f1: Number, f2: Number, f3: Number, f4: Number,
		f5: Number, f6: Number, f7: Number, f8: Number,
		clearChannel: Number, nirChannel: Number
	}],
	processedAt: Date
}, { timestamps: true });

export const TestResult = mongoose.models.TestResult || mongoose.model('TestResult', testResultSchema, 'test_results');
