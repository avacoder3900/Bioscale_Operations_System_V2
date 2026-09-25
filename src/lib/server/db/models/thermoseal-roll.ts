import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * ThermosealRoll — one physical roll of thermoseal (THERMOSEAL_PART, PT-CT-101)
 * that has been pulled from inventory and opened at the press (BUCKET-SYSTEM_PLAN
 * v2 §3.4).
 *
 * Thermoseal inventory is counted ONLY in ROLLS. Consumption is tracked in
 * centimetres against the open roll: every cartridge that enters Unpressed
 * takes `cmPerCartridge` (3.75 cm) off `consumedCm`. When the roll's length
 * is used up it becomes 'exhausted' and the next roll is pulled — that pull
 * is the only moment the thermoseal inventory count moves (−1 roll, one
 * InventoryTransaction whose manufacturingRunId is the roll id, so voiding a
 * bucket pass never gives a physically opened roll back to stock).
 *
 * At most one roll is 'active' at a time.
 */
const thermosealRollSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	partNumber: { type: String, default: 'PT-CT-101' },
	lotId: String,                 // ReceivingLot.lotId the roll was pulled from (when known)
	lengthCm: { type: Number, required: true },   // full length when opened (65 m = 6500 cm)
	consumedCm: { type: Number, default: 0 },
	status: { type: String, enum: ['active', 'exhausted', 'retired'], default: 'active' },
	openedAt: { type: Date, default: Date.now },
	openedBy: { _id: String, username: String },
	openedForCycleId: String,      // bucket pass whose advance pulled this roll
	exhaustedAt: Date,
	retiredAt: Date,
	retiredReason: String,
	inventoryTxId: String          // the −1 roll consumption transaction
}, { timestamps: false });

thermosealRollSchema.index({ status: 1, openedAt: -1 });

export const ThermosealRoll = mongoose.models.ThermosealRoll
	|| mongoose.model('ThermosealRoll', thermosealRollSchema, 'thermoseal_rolls');
