import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const processConfigurationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	processName: String, processType: String,
	inputMaterials: Schema.Types.Mixed, outputMaterial: Schema.Types.Mixed,
	maxBatchSize: Number, handoffPrompt: String,
	downstreamQueue: String, workInstructionId: String,
	steps: [{
		_id: { type: String, default: () => generateId() },
		stepNumber: Number, title: String, description: String, imageUrl: String
	}]
}, { timestamps: true });

export const ProcessConfiguration = mongoose.models.ProcessConfiguration || mongoose.model('ProcessConfiguration', processConfigurationSchema, 'process_configurations');
