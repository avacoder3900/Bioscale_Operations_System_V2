import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const productionRunSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	workInstructionId: String, workInstructionVersionId: String,
	quantity: Number,
	status: { type: String, enum: ['planning', 'in_progress', 'paused', 'completed'] },
	leadBuilder: { _id: String, username: String },
	runNumber: String,
	startedAt: Date, pausedAt: Date, completedAt: Date,
	units: [{
		_id: { type: String, default: () => generateId() },
		spuId: String, assemblySessionId: String, unitIndex: Number,
		status: { type: String, enum: ['pending', 'in_progress', 'completed'] },
		startedAt: Date, completedAt: Date
	}]
}, { timestamps: true });

export const ProductionRun = mongoose.models.ProductionRun || mongoose.model('ProductionRun', productionRunSchema, 'production_runs');
