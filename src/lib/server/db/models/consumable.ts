import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const consumableSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	type: { type: String, enum: ['incubator_tube', 'top_seal_roll', 'deck', 'cooling_tray'] },
	status: String,
	// Incubator tube
	initialVolumeUl: Number, remainingVolumeUl: Number,
	totalCartridgesFilled: Number, totalRunsUsed: Number,
	firstUsedAt: Date, lastUsedAt: Date, registeredBy: String,
	// Top seal roll
	barcode: String, initialLengthFt: Number, remainingLengthFt: Number,
	// Deck
	currentRobotId: String, lockoutUntil: Date, lastUsed: Date,
	// Cooling tray
	currentCartridges: Schema.Types.Mixed, assignedRunId: String,
	// Usage log
	usageLog: [{
		_id: { type: String, default: () => generateId() },
		usageType: String, runId: String, quantityChanged: Number,
		volumeChangedUl: Number, remainingBefore: Number, remainingAfter: Number,
		operator: { _id: String, username: String }, notes: String, createdAt: Date
	}]
}, { timestamps: true });

export const Consumable = mongoose.models.Consumable || mongoose.model('Consumable', consumableSchema, 'consumables');
