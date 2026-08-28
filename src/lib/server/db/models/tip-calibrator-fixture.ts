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
 * KEYED BY DECK (2026-08-28). The fixture is bolted to the cartridge carriage,
 * so it travels with the DECK, not the robot — but this was keyed
 * `robotId: unique`, one row per robot. Swapping B14 onto the robot-arm deck
 * therefore overwrote the reagent deck's calibrator point with the arm rig's
 * (194mm away, probe Z 17mm low), and swapping back left a record describing a
 * fixture that was no longer there. `deckKey` is the calibrator's own Particle
 * serial id (what the .py reads at run start to choose the deck definition), so
 * the geometry and the calibrator point can never disagree about which deck is
 * mounted; `deckLoadName` is carried for humans. Legacy robot-keyed rows still
 * resolve as a fallback, and a deckKey of 'global' is the shared default.
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
	/**
	 * Primary key since 2026-08-28: the calibrator/carriage Particle device id
	 * (e.g. 'e00fce68fc3b…'), or 'global' for the shared fallback. Sparse-unique
	 * so legacy robot-keyed rows (deckKey absent) keep loading untouched.
	 */
	deckKey: { type: String, default: null, index: true },
	/** Human-facing deck this fixture belongs to, e.g. 'gen4deck_gen7cartridge_003'. */
	deckLoadName: { type: String, default: null, index: true },
	/**
	 * Legacy key / last robot this fixture was taught on. No longer unique: a
	 * robot has as many calibrator points as it has decks it runs.
	 */
	robotId: { type: String, required: true, index: true },
	position: { type: vec, required: true }, // approach point the tip moves to before the probe
	zCalWax: { type: Number, default: 34.491 }, // p20 tip cal Z
	zCalReagent: { type: Number, default: 40.8 }, // p300 tip cal Z
	/**
	 * Largest tip-calibration adjust this robot may apply, in mm. Optional —
	 * absent means the protocol's own default (4.0) stands.
	 *
	 * Per robot because the cap is compared against the RAW adjust, which is
	 * `calibrator baseline - travel-to-switch` and therefore carries that
	 * fixture's dialled baseline. R04 sits at -5.0 so a normal wax adjust is
	 * ~-6.0; B07 sits at -1.0 so its normal is ~-2.2. One global number cannot
	 * be tight enough for B07 and loose enough for R04 at the same time.
	 */
	maxTipAdjust: { type: Number, default: null },
	capturedBy: { type: operatorRef },
	capturedAt: { type: Date, default: Date.now },
	// Newest-first list of the points this one replaced. Capped at 10 on write.
	history: { type: [calibratorHistoryEntry], default: [] }
});

tipCalibratorFixtureSchema.index(
	{ deckKey: 1 },
	{ unique: true, partialFilterExpression: { deckKey: { $type: 'string' } } }
);

export const TipCalibratorFixture =
	mongoose.models.TipCalibratorFixture ||
	mongoose.model('TipCalibratorFixture', tipCalibratorFixtureSchema, 'tip_calibrator_fixtures');
