import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * NATIVE-CALIBRATION-SYSTEM PRD 2 / PRD 5: per-robot GLOBAL position offset.
 *
 * Deck/rack geometry is tuned once (in labware_definitions) against a designated
 * REFERENCE robot (offset 0,0,0). Every other robot gets a global x/y/z offset that
 * shifts ALL labware to account for that robot's mechanical differences — discovered
 * by tuning a deck on the reference robot, moving it to robot B, and jogging to a
 * known hole; the delta is robot B's offset. One active offset per robot; applied at
 * fill time as a runtime parameter (replaces the hardcoded ROBOT_OFFSETS in the .py).
 */
const vec = new Schema(
	{ x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, z: { type: Number, default: 0 } },
	{ _id: false }
);

const operatorRef = new Schema(
	{ _id: { type: String }, username: { type: String } },
	{ _id: false }
);

const robotDeckOffsetSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robotId: { type: String, required: true, unique: true, index: true },
	offset: { type: vec, required: true },
	// Exactly one robot should be the reference (offset 0,0,0); geometry is tuned against it.
	isReference: { type: Boolean, default: false },
	capturedBy: { type: operatorRef },
	capturedAt: { type: Date, default: Date.now },
	note: { type: String }
});

export const RobotDeckOffset =
	mongoose.models.RobotDeckOffset ||
	mongoose.model('RobotDeckOffset', robotDeckOffsetSchema, 'robot_deck_offsets');
