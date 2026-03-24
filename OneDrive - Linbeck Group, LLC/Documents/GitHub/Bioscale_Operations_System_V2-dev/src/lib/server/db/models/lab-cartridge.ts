import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const labCartridgeSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	barcode: String, serialNumber: String, lotNumber: String,
	cartridgeType: { type: String, enum: ['measurement', 'calibration', 'reference', 'test'] },
	status: { type: String, enum: ['available', 'in_use', 'depleted', 'expired', 'quarantine', 'disposed'] },
	groupId: String, partDefinitionId: String, manufacturer: String,
	expirationDate: Date, receivedDate: Date, openedDate: Date,
	usesRemaining: Number, totalUses: Number,
	storageLocation: String, storageConditions: String,
	notes: String, isActive: { type: Boolean, default: true },
	usageLog: [{
		_id: { type: String, default: () => generateId() },
		action: { type: String, enum: ['registered', 'scanned', 'used', 'returned', 'quarantined', 'disposed', 'status_changed', 'group_changed', 'exported', 'deleted'] },
		previousValue: String, newValue: String,
		spuId: String, validationSessionId: String, notes: String,
		performedBy: { _id: String, username: String }, performedAt: Date
	}],
	createdBy: String
}, { timestamps: true });

export const LabCartridge = mongoose.models.LabCartridge || mongoose.model('LabCartridge', labCartridgeSchema, 'lab_cartridges');
