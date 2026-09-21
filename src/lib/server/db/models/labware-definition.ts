import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * LabwareDefinition — BIMS-managed custom Opentrons labware library
 * (LABWARE-LIBRARY-AUTO-BUNDLE). Mirrors Opentrons' custom-labware manager:
 * definitions are uploaded once and bundled with every protocol upload to a
 * robot, which is how the OT-2 resolves a protocol's custom labware at run time.
 */
const labwareDefinitionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	namespace: { type: String, required: true },   // e.g. cosmas_damian, custom_beta
	loadName: { type: String, required: true },     // e.g. cosmas_and_damian_drybath_tuberack
	version: { type: Number, required: true, default: 1 },
	displayName: String,                            // metadata.displayName
	category: String,                               // metadata.displayCategory
	fileName: String,                               // original .json filename (display only)
	definition: { type: Schema.Types.Mixed, required: true }, // the full labware JSON
	uploadedBy: String,

	// ── Deck version control (deck_versions) ────────────────────────────────
	// `version` above is the Opentrons identity component and is bumped on
	// PUBLISH, not on each jog edit. These two track the relationship between
	// the live working geometry and the frozen history.
	/** Highest version frozen into deck_versions. Null until first publish. */
	lastPublishedVersion: { type: Number, default: null },
	/** True when jog edits have landed since lastPublishedVersion was frozen. */
	hasUnpublishedEdits: { type: Boolean, default: false }
}, { timestamps: true });

// One row per (namespace, loadName, version) — re-upload upserts.
labwareDefinitionSchema.index({ namespace: 1, loadName: 1, version: 1 }, { unique: true });

export const LabwareDefinition = mongoose.models.LabwareDefinition
	|| mongoose.model('LabwareDefinition', labwareDefinitionSchema, 'labware_definitions');
