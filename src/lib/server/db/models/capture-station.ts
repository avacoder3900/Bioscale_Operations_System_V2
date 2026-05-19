import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const captureStationSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: { type: String, required: true },
	hostname: { type: String, required: true },
	ipAddress: String,
	location: String,
	agentVersion: String,
	lastSeenAt: Date,
	status: { type: String, enum: ['online', 'offline', 'degraded'] },
	capabilities: {
		_id: false,
		camera: Boolean,
		scanner: Boolean,
		led: Boolean,
		robotArm: Boolean
	},
	mode: { type: String, enum: ['free', 'assigned'], default: 'free' },
	assignedPhase: String,
	currentOperator: {
		_id: String,
		username: String,
		since: Date
	},
	// bcrypt hash of the station auth token. Plaintext is returned once
	// at registration and never stored.
	token: String,
	createdBy: { _id: String, username: String },
	createdAt: Date
}, { timestamps: true });

captureStationSchema.index({ hostname: 1 }, { unique: true });

export const CaptureStation = mongoose.models.CaptureStation || mongoose.model('CaptureStation', captureStationSchema, 'capture_stations');
