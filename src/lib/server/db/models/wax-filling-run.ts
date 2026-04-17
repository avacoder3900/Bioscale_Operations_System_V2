import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const waxFillingRunSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robot: { _id: String, name: String },
	deckId: String, ovenId: String, waxSourceLot: String, waxTubeId: String, waxTubeTimestamp: Date,
	setupTimestamp: Date, runStartTime: Date, runEndTime: Date,
	deckRemovedTime: Date, coolingConfirmedTime: Date,
	// Set when the OT-2 finishes (confirmDeckRemoved). Once present, the run
	// no longer locks the robot — operators can start a new run while the
	// post-OT-2 steps (cooling/QC/storage) continue on the Opentron Control page.
	robotReleasedAt: Date,
	coolingTrayId: String, ovenLocationId: String, coolingLocationId: String,
	activeLotId: String,
	status: String,
	operator: { _id: String, username: String },
	abortReason: String, plannedCartridgeCount: Number,
	cartridgeIds: [String]
}, { timestamps: true });

export const WaxFillingRun = mongoose.models.WaxFillingRun || mongoose.model('WaxFillingRun', waxFillingRunSchema, 'wax_filling_runs');
