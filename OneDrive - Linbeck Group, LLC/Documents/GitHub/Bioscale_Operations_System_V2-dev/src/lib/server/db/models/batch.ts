import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const batchSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	batchNumber: String, description: String, targetQuantity: Number,
	startedAt: Date, completedAt: Date,
	createdAt: { type: Date, default: Date.now }, createdBy: String
}, { timestamps: false });

export const Batch = mongoose.models.Batch || mongoose.model('Batch', batchSchema, 'batches');
