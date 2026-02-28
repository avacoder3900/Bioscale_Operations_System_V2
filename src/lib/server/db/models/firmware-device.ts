import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const firmwareDeviceSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	deviceId: String, apiKey: String, firmwareVersion: String,
	dataFormatVersion: String, lastSeen: Date, metadata: Schema.Types.Mixed
}, { timestamps: true });

export const FirmwareDevice = mongoose.models.FirmwareDevice || mongoose.model('FirmwareDevice', firmwareDeviceSchema, 'firmware_devices');
