import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const particleDeviceSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	particleDeviceId: String, name: String, serialNumber: String,
	platformId: Number, firmwareVersion: String, systemVersion: String,
	status: String, lastHeardAt: Date, lastIpAddress: String,
	notes: String, linkedSpuId: String, linkedAt: Date, linkedBy: String,
	needsAttention: { type: Boolean, default: false }, attentionReason: String
}, { timestamps: true });

export const ParticleDevice = mongoose.models.ParticleDevice || mongoose.model('ParticleDevice', particleDeviceSchema, 'particle_devices');
