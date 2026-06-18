import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * NATIVE-CALIBRATION-SYSTEM PRD 2: the tip-calibrator position.
 *
 * The tip calibrator is a fixed limit-switch fixture (NOT labware) the pipette
 * touches to zero a tip: limit-switch reading − the calibrator's serial "bend"
 * string = the tip's true position. The .py hardcoded its location
 * (x125.181, y173.247, z 34.491 wax / 40.8 reagent, relative to the carriage).
 * This makes the position BIMS-tunable (jog → save) and fed to the .py as an RTP.
 * Keyed by robotId; a robotId of 'global' is the fallback used until a per-robot
 * value is captured.
 */
const vec = new Schema(
	{ x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, z: { type: Number, default: 0 } },
	{ _id: false }
);

const operatorRef = new Schema(
	{ _id: { type: String }, username: { type: String } },
	{ _id: false }
);

const tipCalibratorFixtureSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robotId: { type: String, required: true, unique: true, index: true }, // robot _id, or 'global'
	position: { type: vec, required: true }, // approach point the tip moves to before the probe
	zCalWax: { type: Number, default: 34.491 }, // p20 tip cal Z
	zCalReagent: { type: Number, default: 40.8 }, // p300 tip cal Z
	capturedBy: { type: operatorRef },
	capturedAt: { type: Date, default: Date.now }
});

export const TipCalibratorFixture =
	mongoose.models.TipCalibratorFixture ||
	mongoose.model('TipCalibratorFixture', tipCalibratorFixtureSchema, 'tip_calibrator_fixtures');
