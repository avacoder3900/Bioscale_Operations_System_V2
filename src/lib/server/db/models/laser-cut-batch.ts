import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const laserCutBatchSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	inputSheetCount: Number, outputSheetCount: Number,
	failureCount: Number, failureNotes: String,
	cuttingProgramLink: String, referencePhotos: Schema.Types.Mixed,
	toolsUsed: String, operatorId: String
}, { timestamps: true });

export const LaserCutBatch = mongoose.models.LaserCutBatch || mongoose.model('LaserCutBatch', laserCutBatchSchema, 'laser_cut_batches');
