import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const opentronsProtocolSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Protocol identity
	protocolName: { type: String, required: true },
	version: { type: Number, default: 1 },
	description: String,
	processType: { type: String, enum: ['wax-filling', 'reagent-filling', 'other'] },

	// File storage
	fileName: String,
	fileHash: String,
	fileContent: String,

	// Robot deployments
	deployments: [{
		_id: { type: String, default: () => generateId() },
		robotId: { type: String, ref: 'OpentronsRobot' },
		robotName: String,
		opentronsProtocolId: String,
		analysisStatus: { type: String, enum: ['pending', 'completed', 'failed'] },
		analysisErrors: [String],
		deployedAt: Date,
		deployedBy: String,
	}],

	// Runtime parameter schema (extracted from analysis)
	parametersSchema: Schema.Types.Mixed,

	// Labware requirements
	labwareRequired: [{
		_id: false,
		loadName: String,
		displayName: String,
		slot: Number,
		isCustom: Boolean,
	}],

	// Pipette requirements
	pipettesRequired: [{
		_id: false,
		pipetteName: String,
		mount: String,
	}],

	tags: [String],
	isActive: { type: Boolean, default: true },

	// Audit
	uploadedBy: String,
	lastModifiedBy: String,
}, { timestamps: true });

opentronsProtocolSchema.index({ processType: 1 });
opentronsProtocolSchema.index({ 'deployments.robotId': 1 });

export const OpentronProtocol = mongoose.models.OpentronProtocol
	|| mongoose.model('OpentronProtocol', opentronsProtocolSchema, 'opentrons_protocols');
