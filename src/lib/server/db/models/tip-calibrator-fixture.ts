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

/**
 * One previously-taught calibrator point, kept so an operator can undo a bad
 * teach without re-jogging. Newest-first, capped at 10 by the writing action
 * ($push + $slice). Every field is optional with a default, so documents saved
 * before this array existed keep loading unchanged — no migration needed.
 *
 * `source` describes the write that REPLACED this value:
 *   manual = typed/jogged and saved, probe = saved from a calibration probe,
 *   revert = this value was displaced by a revert to an older point.
 */
const calibratorHistoryEntry = new Schema(
	{
		position: { type: vec, default: () => ({ x: 0, y: 0, z: 0 }) },
		zCalWax: { type: Number, default: 34.491 },
		zCalReagent: { type: Number, default: 40.8 },
		capturedBy: { type: operatorRef },
		capturedAt: { type: Date, default: Date.now },
		source: { type: String, enum: ['manual', 'probe', 'revert'], default: 'manual' },
		note: { type: String, default: null }
	},
	{ _id: false }
);

const tipCalibratorFixtureSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robotId: { type: String, required: true, unique: true, index: true }, // robot _id, or 'global'
	position: { type: vec, required: true }, // approach point the tip moves to before the probe
	zCalWax: { type: Number, default: 34.491 }, // p20 tip cal Z
	zCalReagent: { type: Number, default: 40.8 }, // p300 tip cal Z
	capturedBy: { type: operatorRef },
	capturedAt: { type: Date, default: Date.now },
	// Newest-first list of the points this one replaced. Capped at 10 on write.
	history: { type: [calibratorHistoryEntry], default: [] }
});

export const TipCalibratorFixture =
	mongoose.models.TipCalibratorFixture ||
	mongoose.model('TipCalibratorFixture', tipCalibratorFixtureSchema, 'tip_calibrator_fixtures');
