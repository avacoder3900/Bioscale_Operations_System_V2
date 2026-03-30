import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const deviceCrashSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Device identification
	deviceId: { type: String, required: true },
	deviceName: { type: String },
	firmwareVersion: { type: Number },
	bootCount: { type: Number },

	// When the crash was detected (= when the NEXT boot uploaded logs)
	detectedAt: { type: Date, default: Date.now, required: true },

	// Checkpoint forensics
	lastCheckpoint: { type: Number, required: true },
	lastCheckpointName: { type: String, required: true },
	checkpointSequence: [{ type: Number }],

	// Classification
	crashCategory: {
		type: String,
		enum: ['CLOUD', 'BCODE', 'I2C', 'FILE_IO', 'HARDWARE', 'TEST_LIFECYCLE', 'HEATER', 'UNKNOWN'],
		required: true
	},

	// Link to full session log
	sessionLogId: { type: String }
}, {
	timestamps: false,
	collection: 'device_crashes'
});

deviceCrashSchema.index({ deviceId: 1, detectedAt: -1 });
deviceCrashSchema.index({ lastCheckpoint: 1 });
deviceCrashSchema.index({ crashCategory: 1, detectedAt: -1 });
// No TTL — crashes kept forever

applyImmutableMiddleware(deviceCrashSchema);

export const DeviceCrash = mongoose.models.DeviceCrash || mongoose.model('DeviceCrash', deviceCrashSchema, 'device_crashes');
