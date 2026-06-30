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
	// Computed 2ml-tube fill volume for this run (WAX-FLOW-3):
	// waxPerCartridgeUl × plannedCartridgeCount + waxFillDeadVolumeUl.
	// completeRun decrements WaxBatch / ReceivingLot volume by this amount.
	fillVolumeUl: Number,
	cartridgeIds: [String],

	// Free-text operator notes attached to the run. Append-only metadata —
	// never gates state transitions. Mirrored to each cartridge's notes[]
	// at write time so the same note appears on the run AND on every
	// cartridge in the run. phase tags the workflow point (e.g. 'wax_run').
	notes: [{
		_id: { type: String, default: () => generateId() },
		body: String,
		phase: String,
		author: { _id: String, username: String },
		createdAt: Date
	}],

	// --- OT-2 integration (the parameter set + linkage to the executed run) ---
	// Captured when the operator hits "Start Run" on this wax run.
	// Mixed because protocol parameter schemas evolve; the wax protocol's
	// add_parameters() is the source of truth for valid keys.
	protocolParameters: Schema.Types.Mixed,
	// OT-2 run id (UUID, returned by `POST /runs` on the robot). Lets us
	// pull commands/errors from the robot for this specific run.
	opentronsRunId: String,
	// Terminal status of the OT-2 .py (succeeded/failed/stopped), stamped by
	// recordRunFinished once the protocol lands terminal. Lets the page show
	// the deck-removal confirmation only after the run completes, on reload too.
	opentronsRunFinalStatus: String,
	// Persistent tip tracker snapshot — captured pre-run from the robot's
	// /data/tip_tracker_<hostname>.json file and stamped again post-run.
	// `consumed` is `after.nextTipIndex - before.nextTipIndex` (or
	// (96 - before) + after if the rack was refilled mid-run).
	pipetteTipState: {
		_id: false,
		before: { nextTipIndex: Number, hostname: String, capturedAt: Date },
		after:  { nextTipIndex: Number, hostname: String, capturedAt: Date },
		consumed: Number,
		rackRefilledDuringRun: Boolean
	},

	// --- Robot-arm transfer step (optional, inserted between OT-2 dispense
	// and scanner sweep on the wax pilot). When the arm-replay protocol step
	// fires, the resulting RobotArmRun.runId is stamped here so the wax run
	// is queryable by arm activity and vice-versa. Single ref by design —
	// only one arm transfer per wax run for now; if the pilot expands to
	// multiple transfers we'll widen this to an array.
	armRunId: { type: String, index: true }
}, { timestamps: true });

// Robot + deck are held through the filling-page-owned stages only.
// Once status passes those (QC / Storage), the deck is off the robot and
// free to reuse — but cartridges still sit on the cooling tray through
// Storage, so the tray uniqueness window is wider (non-terminal).
// Stages where the robot/deck are still held — i.e. cartridges are physically
// on the deck being wax-filled. Exported as the canonical "in the filling step"
// window so dashboards can derive that marker from run membership instead of a
// cartridge status value. See $lib/server/in-filling.ts.
export const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal',
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
