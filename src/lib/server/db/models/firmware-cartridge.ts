import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const firmwareCartridgeSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	cartridgeUuid: String, assayId: String, status: String,
	lotNumber: String, expirationDate: Date, serialNumber: String,
	siteId: String, program: String, experiment: String, arm: String, quantity: Number,
	validationErrors: Schema.Types.Mixed, statusUpdatedAt: Date,
	validationCount: Number, lastValidatedAt: Date, lastValidatedBy: String,
	testResultId: String, metadata: Schema.Types.Mixed
}, { timestamps: true });

export const FirmwareCartridge = mongoose.models.FirmwareCartridge || mongoose.model('FirmwareCartridge', firmwareCartridgeSchema, 'firmware_cartridges');
