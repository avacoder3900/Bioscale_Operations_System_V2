import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// FIX-03: Typed sub-schemas replacing Schema.Types.Mixed
const inputMaterialSchema = new Schema({
	partDefinitionId: String,
	partNumber: String,
	name: String,
	scanOrder: Number,
	quantityRequired: { type: Number, default: 1 }
}, { _id: false });

const outputMaterialSchema = new Schema({
	partDefinitionId: String,
	partNumber: String,
	name: String,
	quantityPerBatch: Number
}, { _id: false });

const processConfigurationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	processName: String, processType: String,
	inputMaterials: { type: [inputMaterialSchema], default: undefined },
	outputMaterial: { type: outputMaterialSchema, default: undefined },
	maxBatchSize: Number, handoffPrompt: String,
	downstreamQueue: String, workInstructionId: String,
	steps: [{
		_id: { type: String, default: () => generateId() },
		stepNumber: Number, title: String, description: String, imageUrl: String
	}]
}, { timestamps: true });

export const ProcessConfiguration = mongoose.models.ProcessConfiguration || mongoose.model('ProcessConfiguration', processConfigurationSchema, 'process_configurations');
