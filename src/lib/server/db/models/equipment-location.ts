import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const equipmentLocationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	parentEquipmentId: String,
	barcode: String, locationType: { type: String, enum: ['fridge', 'oven'] },
	displayName: String, isActive: { type: Boolean, default: true },
	capacity: Number, notes: String,
	currentPlacements: [{
		_id: { type: String, default: () => generateId() },
		itemType: String, itemId: String, placedBy: String,
		placedAt: Date, runId: String, notes: String
	}]
}, { timestamps: true });

export const EquipmentLocation = mongoose.models.EquipmentLocation || mongoose.model('EquipmentLocation', equipmentLocationSchema, 'equipment_locations');
