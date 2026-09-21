import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * DeckVersion — immutable, append-only history of cartridge-deck geometry.
 *
 * A "deck" in BIMS is a LabwareDefinition whose loadName matches
 * /(gen4deck|cartridge_deck)/i. `labware_definitions` holds the CURRENT working
 * geometry, which the Deck Calibration Studio edits in place, hole by hole.
 * Nothing preserved the whole-deck state at the moment it was known good, so a
 * deck that filled correctly on Monday could not be recovered after Tuesday's
 * jog session. This collection is that recovery path.
 *
 * Rows are written on PUBLISH (Sync), never on individual jog edits — a version
 * is a deck someone decided to run, not an intermediate nudge. Per-hole nudges
 * remain in `deck_calibration_edits`.
 *
 * NEVER update or delete a row here. Rollback copies an old `definition`
 * FORWARD as a new, higher version and stamps `rolledBackFrom`. Reusing a
 * version number with different geometry is exactly what Opentrons forbids:
 * definition identity is the triple namespace/loadName/version, and calibration
 * is keyed to it, so a mutated definition at a stale version silently applies
 * old calibration to new geometry.
 */
const deckVersionSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	// Identity — the Opentrons triple this snapshot was published as.
	deckLoadName: { type: String, required: true, index: true },
	namespace: { type: String, required: true },
	version: { type: Number, required: true },

	// The frozen payload. Full labware JSON exactly as bundled to the robot.
	definition: { type: Schema.Types.Mixed, required: true },
	/** sha256 of the canonicalised definition — cheap equality across systems. */
	definitionHash: { type: String, required: true, index: true },

	// Denormalised for listing a version history without loading 576-well blobs.
	wellCount: Number,
	dimensions: { x: Number, y: Number, z: Number },

	publishedAt: { type: Date, default: Date.now },
	publishedBy: String,
	/** Operator-supplied reason, e.g. "post-jog X2 correction, verified on R04". */
	note: String,

	/** Set when this row was produced by rolling back to an earlier version. */
	rolledBackFrom: { type: Number, default: null },
	/** How many deck_calibration_edits rows landed since the previous publish. */
	editsSincePrevious: { type: Number, default: 0 },

	/** Robots this exact snapshot was successfully bundled to. */
	publishedToRobots: [{
		_id: false,
		robotId: String,
		robotName: String,
		opentronsProtocolId: String,
		at: Date
	}]
}, { timestamps: true });

// One row per (deck, version). The unique index is the guard that makes
// "immutable" enforceable rather than merely intended.
deckVersionSchema.index({ deckLoadName: 1, version: 1 }, { unique: true });
deckVersionSchema.index({ deckLoadName: 1, publishedAt: -1 });

export const DeckVersion = mongoose.models.DeckVersion
	|| mongoose.model('DeckVersion', deckVersionSchema, 'deck_versions');
