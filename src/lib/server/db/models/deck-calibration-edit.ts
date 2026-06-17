import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * CALIB-1: append-only audit of every per-hole deck-JSON nudge made via the deck
 * tuner. Each row is one well's jog delta + before/after coords + who/when. The
 * live well coords live in `labware_definitions`; this is the correction history
 * (the deck JSON is a correction-tracked artifact, never silently overwritten).
 */
const vec = new Schema(
	{ x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, z: { type: Number, default: 0 } },
	{ _id: false }
);

const deckCalibrationEditSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	deckLoadName: { type: String, required: true, index: true }, // e.g. gen4deck_gen7cartridge_004
	deckEquipmentId: { type: String, default: null }, // canonical deck id, e.g. DECK-004 (if known)
	wellName: { type: String, required: true }, // e.g. M14
	delta: { type: vec, required: true },
	before: { type: vec, required: true },
	after: { type: vec, required: true },
	robotId: { type: String, default: null }, // robot used to perform the jog
	createdBy: { type: String },
	createdAt: { type: Date, default: Date.now }
});

deckCalibrationEditSchema.index({ deckLoadName: 1, wellName: 1, createdAt: -1 });

export const DeckCalibrationEdit =
	mongoose.models.DeckCalibrationEdit ||
	mongoose.model('DeckCalibrationEdit', deckCalibrationEditSchema, 'deck_calibration_edits');
