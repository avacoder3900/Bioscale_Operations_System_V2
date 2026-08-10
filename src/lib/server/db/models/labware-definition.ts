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
	// Optional project tag (e.g. 'ARM-WAX-01') so project pages can list just
	// their own tooling. Untagged defs are general library entries.
	project: String
}, { timestamps: true });

// One row per (namespace, loadName, version) — re-upload upserts.
labwareDefinitionSchema.index({ namespace: 1, loadName: 1, version: 1 }, { unique: true });

export const LabwareDefinition = mongoose.models.LabwareDefinition
	|| mongoose.model('LabwareDefinition', labwareDefinitionSchema, 'labware_definitions');
