import mongoose, { Schema } from 'mongoose';

/**
 * ProtocolDefinition — research-v2 collection, shared Mongo Atlas.
 *
 * Versioned recipes with parameters/materials/steps. Read-only from BIMS.
 *
 * Critical integrity note (per docs/protocol-extraction-cellmap-bug.md):
 * cellMap is currently EMPTY on every live protocol because protocols were
 * extracted before the parser landed. Editing input parameters does NOT
 * cascade through formulas until the protocols are re-extracted. The
 * find_protocol tool surfaces this in dataIntegrityNotes.
 */

const protocolDefinitionSchema = new Schema(
	{
		_id: String,
		name: String,
		version: Number,
		status: String,
		category: String,
		description: String,
		outputCatalogId: String,
		outputType: String,
		parameters: { type: Schema.Types.Mixed, default: [] },
		materials: { type: Schema.Types.Mixed, default: [] },
		steps: { type: Schema.Types.Mixed, default: [] },
		versionHistory: { type: Schema.Types.Mixed, default: [] },
		cellMap: { type: Schema.Types.Mixed, default: {} },
		sourceSpreadsheet: String,
		importedAt: String,
		importedBy: String
	},
	{ strict: false, timestamps: true }
);

export const ProtocolDefinition =
	mongoose.models.ProtocolDefinition ||
	mongoose.model('ProtocolDefinition', protocolDefinitionSchema, 'protocol_definitions');
