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

// Robot + deck are held through the filling-page-owned stages only.
// Once status passes those (QC / Storage), the deck is off the robot and
// free to reuse — but cartridges still sit on the cooling tray through
// Storage, so the tray uniqueness window is wider (non-terminal).
const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling'];
const WAX_NON_TERMINAL = ['Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling', 'qc', 'storage'];

waxFillingRunSchema.index(
	{ 'robot._id': 1 },
	{ unique: true, partialFilterExpression: { status: { $in: WAX_PAGE_OWNED }, 'robot._id': { $exists: true } }, name: 'robot_active_unique' }
);
waxFillingRunSchema.index(
	{ deckId: 1 },
	{ unique: true, partialFilterExpression: { status: { $in: WAX_PAGE_OWNED }, deckId: { $exists: true } }, name: 'deck_active_unique' }
);
waxFillingRunSchema.index(
	{ coolingTrayId: 1 },
	{ unique: true, partialFilterExpression: { status: { $in: WAX_NON_TERMINAL }, coolingTrayId: { $exists: true } }, name: 'tray_active_unique' }
);

export const WaxFillingRun = mongoose.models.WaxFillingRun || mongoose.model('WaxFillingRun', waxFillingRunSchema, 'wax_filling_runs');
