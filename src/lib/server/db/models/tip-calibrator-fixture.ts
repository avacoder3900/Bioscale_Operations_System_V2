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
 *   revert = this value was displaced by a revert to an older point,
 *   frame  = displaced by a re-derive from a freshly-taught deck frame,
 *   sensor = displaced by a point taught from live limit-switch trips.
 */
const calibratorHistoryEntry = new Schema(
	{
		position: { type: vec, default: () => ({ x: 0, y: 0, z: 0 }) },
		zCalWax: { type: Number, default: 34.491 },
		zCalReagent: { type: Number, default: 40.8 },
		capturedBy: { type: operatorRef },
		capturedAt: { type: Date, default: Date.now },
		source: {
			type: String,
			enum: ['manual', 'probe', 'revert', 'frame', 'sensor'],
			default: 'manual'
		},
		note: { type: String, default: null },
		/**
		 * The limit-switch trips this point was taught from, when it was taught
		 * from a live sensor watch. The durable copy of "when did each sensor
		 * activate, and where was the tip when it did" — the watch itself lives on
		 * the bridge-command queue message and ages out within days.
		 */
		switchEvents: { type: [Schema.Types.Mixed], default: [] }
	},
	{ _id: false }
);

const tipCalibratorFixtureSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robotId: { type: String, required: true, unique: true, index: true }, // robot _id, or 'global'
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
	/**
	 * Where this calibrator sits as a FRACTION of the robot's taught deck frame
	 * (see deck-frame.ts): u across the deck, v front-to-back, 0..1 inside it.
	 *
	 * `position` above stays the absolute source of truth that the production
	 * fill path reads — resolveCalibratorPoint() does not look at this field, so
	 * a robot with no frame behaves exactly as before. This is the input to the
	 * RE-DERIVE: when the corners are re-taught after a deck is reseated, the new
	 * absolute position is fromFrameRelative(newFrame, this), which is what makes
	 * a reseat a four-corner jog instead of a re-probe.
	 *
	 * Null until the calibrator is saved against a frame. `frameId` records which
	 * frame the fraction was measured in, so a re-derive can tell a stale pairing
	 * from a current one.
	 */
	frameRelative: {
		type: new Schema(
			{
				u: { type: Number, required: true },
				v: { type: Number, required: true },
				frameId: { type: String, default: null },
				derivedAt: { type: Date, default: Date.now }
			},
			{ _id: false }
		),
		default: null
	},
	/**
	 * THE calibrator's anchor: one taught deck hole, and the calibrator's offset
	 * from it.
	 *
	 * This replaces frameRelative as what the calibrator hangs off, because a
	 * hole is a far better reference than the deck's plate corners: a hole has a
	 * NOMINAL position in the deck's own labware definition, so "the calibrator
	 * is 3.97 mm left and 99.65 mm back of hole H12" is a statement about the
	 * geometry the robot actually fills. A plate corner has no nominal at all —
	 * the four-corner frame could only ever describe where the plate sat, never
	 * relate it to the wells.
	 *
	 * It also costs the operator one jog instead of four, and re-teaching is one
	 * jog too: move to the same hole after a deck is reseated, capture it, and
	 * the calibrator's absolute position follows.
	 *
	 * `nominal` is the definition's coordinate for that well AT TEACH TIME, kept
	 * so a later change to the deck definition shows up as a discrepancy rather
	 * than silently shifting the calibrator. `taught` is where the tip actually
	 * was. The calibrator's absolute position is taught + offset.
	 *
	 * Null until a reference hole is captured. `position` above remains the
	 * absolute source of truth the production fill path reads, so a robot without
	 * a reference hole behaves exactly as it always has.
	 */
	referenceHole: {
		type: new Schema(
			{
				deckLoadName: { type: String, required: true },
				wellName: { type: String, required: true },
				nominal: { type: vec, required: true },
				taught: { type: vec, required: true },
				/**
				 * Calibrator minus the taught hole position, in mm — the quantity that
				 * survives a reseat. Re-teach the hole and this is re-applied to the
				 * new taught position.
				 *
				 * dz is RECORDED BUT NEVER APPLIED on re-derive: the calibrator's z is
				 * an approach height above a fixture, not a depth below the deck plane,
				 * so inferring it from a hole would be a guess on the one axis where
				 * guessing wrong drives the pipette into the fixture.
				 */
				offset: { type: vec, default: null },
				capturedBy: { type: operatorRef },
				capturedAt: { type: Date, default: Date.now }
			},
			{ _id: false }
		),
		default: null
	},
	capturedBy: { type: operatorRef },
	capturedAt: { type: Date, default: Date.now },
	// Newest-first list of the points this one replaced. Capped at 10 on write.
	history: { type: [calibratorHistoryEntry], default: [] }
});

export const TipCalibratorFixture =
	mongoose.models.TipCalibratorFixture ||
	mongoose.model('TipCalibratorFixture', tipCalibratorFixtureSchema, 'tip_calibrator_fixtures');
