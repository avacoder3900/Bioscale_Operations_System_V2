import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const inspectionResultSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	lotId: { type: String, required: true }, // ReceivingLot._id
	sampleNumber: { type: Number, required: true },
	stepOrder: { type: Number, required: true },
	inputType: { type: String, required: true }, // 'pass_fail' | 'yes_no' | 'dimension' | 'visual_inspection'
	questionLabel: { type: String, required: true },
	expectedValue: String,
	actualValue: { type: String, required: true },
	result: { type: String, enum: ['pass', 'fail', 'manual_review'], required: true },
	toolUsed: String,
	notes: String
}, { timestamps: true });

inspectionResultSchema.index({ lotId: 1 });

export const InspectionResult = mongoose.models.InspectionResult
	|| mongoose.model('InspectionResult', inspectionResultSchema, 'inspection_results');
