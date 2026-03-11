import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const equipmentSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: String, equipmentType: { type: String, enum: ['fridge', 'oven', 'magnetometer'] },
	location: String, status: { type: String, enum: ['active', 'maintenance', 'offline'] },
	mocreoDeviceId: String, mocreoAssetId: String,
	temperatureMinC: Number, temperatureMaxC: Number,
	currentTemperatureC: Number, lastTemperatureReadAt: Date, notes: String,
	// Magnetometer-specific fields
	particleDeviceId: String,
	particleDeviceName: String,
	serialNumber: String
}, { timestamps: true });

export const Equipment = mongoose.models.Equipment || mongoose.model('Equipment', equipmentSchema, 'equipment');
