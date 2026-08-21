import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * The taught deck frame — where the deck plate physically sits on this robot.
 *
 * The operator jogs the pipette tip to the four physical corners of the deck and
 * saves them. Those four points define the deck's origin, size and rotation in
 * robot coordinates, which is what lets BIMS answer two questions it previously
 * could not:
 *
 *   • how much usable area is there, and is a given point even on the deck;
 *   • where did the deck MOVE to, when it is reseated.
 *
 * The second one is the reason this exists. The tip calibrator used to be stored
 * as a bare absolute point (see tip-calibrator-fixture.ts), so reseating the deck
 * silently invalidated it with nothing to show for it. With a frame, the
 * calibrator is stored as a fraction of the deck and its absolute position is
 * re-derived from a fresh corner teach — no re-probing the fixture.
 *
 * Keyed by robotId: the deck definition is shared across the fleet, but where a
 * plate sits in ITS robot is per-machine. Unlike TipCalibratorFixture there is
 * deliberately NO 'global' fallback row — a frame is a measurement of one
 * physical machine, and inheriting another robot's would be a fiction that reads
 * as fact. A robot with no row simply has no frame yet.
 *
 * Geometry (fitting, validation, the u/v mapping) lives in
 * $lib/server/services/deck-calibration/deck-frame.ts. This file is storage only.
 */
const point2 = new Schema(
	{ x: { type: Number, default: 0 }, y: { type: Number, default: 0 } },
	{ _id: false }
);

const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

/** One taught corner, in absolute robot mm, exactly as the pipette read it. */
const cornerSchema = new Schema(
	{
		label: { type: String, enum: ['FL', 'FR', 'BR', 'BL'], required: true },
		x: { type: Number, required: true },
		y: { type: Number, required: true },
		z: { type: Number, required: true },
		capturedAt: { type: Date, default: Date.now },
		capturedBy: { type: operatorRef }
	},
	{ _id: false }
);

/**
 * The fitted frame. Every field is DERIVED from `corners` — nothing here is
 * independently authoritative, and all of it is recomputed by deriveFrame() on
 * each save. It is stored rather than recomputed on read so the values the
 * operator actually approved are the values on the record.
 */
const derivedSchema = new Schema(
	{
		origin: { type: point2, required: true },
		uAxis: { type: point2, required: true },
		vAxis: { type: point2, required: true },
		width: { type: Number, required: true },
		height: { type: Number, required: true },
		rotationDeg: { type: Number, required: true },
		squarenessDeg: { type: Number, required: true },
		/**
		 * Fit quality, mm. NOT "how far a corner was off" — the fit absorbs three
		 * quarters of a single mis-jogged corner, so this reads a quarter of the
		 * real error. See MAX_RESIDUAL_MM in the geometry module.
		 */
		residualMm: { type: Number, required: true },
		surfaceZ: { type: Number, required: true }
	},
	{ _id: false }
);

/**
 * A previously-taught frame, kept so a bad teach can be undone without
 * re-jogging four corners. Newest-first, capped by the writing action
 * ($push + $slice) — the same pattern as TipCalibratorFixture.history.
 */
const frameHistoryEntry = new Schema(
	{
		corners: { type: [cornerSchema], default: [] },
		derived: { type: derivedSchema },
		capturedBy: { type: operatorRef },
		capturedAt: { type: Date, default: Date.now },
		note: { type: String, default: null }
	},
	{ _id: false }
);

const deckFrameSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	robotId: { type: String, required: true, unique: true, index: true },
	/** Which deck definition was on the robot when these corners were taught. */
	deckLoadName: { type: String, default: null },
	/** Exactly four, one per label. Enforced by validateCorners() before write. */
	corners: { type: [cornerSchema], required: true },
	derived: { type: derivedSchema, required: true },
	capturedBy: { type: operatorRef },
	capturedAt: { type: Date, default: Date.now },
	history: { type: [frameHistoryEntry], default: [] }
});

export const DeckFrame =
	mongoose.models.DeckFrame || mongoose.model('DeckFrame', deckFrameSchema, 'deck_frames');
