import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const assemblySessionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	spuId: String, userId: String,
	status: { type: String, enum: ['in_progress', 'paused', 'completed'] },
	currentStepIndex: Number,
	startedAt: Date, pausedAt: Date, completedAt: Date,
	workstationId: String, notes: String,
	workInstructionId: String, workInstructionVersion: Number, workInstructionTitle: String,
	stepRecords: [{
		_id: { type: String, default: () => generateId() },
		stepNumber: Number, stepTitle: String, workInstructionStepId: String,
		scannedLotNumber: String, scannedPartNumber: String,
		completedAt: Date, completedBy: operatorRef, signatureId: String, notes: String,
		fieldRecords: [{
			_id: { type: String, default: () => generateId() },
			stepFieldDefinitionId: String, fieldName: String, fieldLabel: String,
			fieldValue: String, rawBarcodeData: String, bomItemId: String,
			scannedAt: Date, enteredAt: Date, capturedBy: String
		}]
	}],
	createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

export const AssemblySession = mongoose.models.AssemblySession || mongoose.model('AssemblySession', assemblySessionSchema, 'assembly_sessions');
