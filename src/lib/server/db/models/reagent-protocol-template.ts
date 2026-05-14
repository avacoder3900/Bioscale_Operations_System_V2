import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * ReagentProtocolTemplate — the versioned recipe for an R&D / cartridge-prep
 * protocol (SuperQD Phase 1, Phase 2, Antibody Biotinylation, Cortisol Buffer,
 * Bead Mix, Tracer, etc.). One document per (name, version). When a chemist
 * runs the protocol, a ReagentLot is created and pins templateVersion at start.
 *
 * Shape was informed by the source spreadsheets (zones: Inputs → Key
 * Parameters → Ratios → Materials Used → Procedure → Calculations → Outputs)
 * and by the research-v2 protocol_definitions schema, but is independent —
 * BIMS owns this collection.
 *
 * `formula` strings on step reagents reference parameter / material / step
 * output keys (e.g. "(finalVolume * desiredConc) / stockConc"). Evaluation
 * lives client-side in the lot runner; the schema just stores the expression.
 */

const parameterSchema = new Schema(
	{
		key: { type: String, required: true },
		label: String,
		unit: String,
		type: { type: String, enum: ['number', 'text', 'select'], default: 'number' },
		defaultValue: Schema.Types.Mixed,
		options: [String],
		helpText: String
	},
	{ _id: false }
);

const ratioSchema = new Schema(
	{
		key: { type: String, required: true },
		label: String,
		parameter1Key: String,
		parameter1Value: Number,
		parameter2Key: String,
		parameter2Value: Number,
		notes: String
	},
	{ _id: false }
);

const materialSchema = new Schema(
	{
		key: { type: String, required: true },
		label: String,
		type: { type: String, enum: ['stock', 'prepared', 'reused'], default: 'stock' },
		defaultBarcode: String,
		defaultConcentration: Number,
		defaultConcentrationUnit: String,
		molecularWeight: Number,
		stockAmount: Number,
		stockUnit: String,
		costPerStockUnit: Number,
		// When this material can be fed by an upstream lot, list the template
		// slugs whose finalized lots are valid sources. Used by the new-lot
		// page to filter the input-lot dropdown to relevant candidates.
		canSourceFromSlugs: { type: [String], default: undefined },
		notes: String
	},
	{ _id: false }
);

const stepReagentSchema = new Schema(
	{
		materialKey: String,
		label: String,
		formula: String,
		unit: String,
		notes: String
	},
	{ _id: false }
);

const qcCheckpointSchema = new Schema(
	{
		key: { type: String, required: true },
		label: String,
		type: {
			type: String,
			enum: ['quantitative', 'qualitative', 'observation'],
			default: 'quantitative'
		},
		unit: String,
		expectedMin: Number,
		expectedMax: Number,
		expectedValue: String,
		helpText: String
	},
	{ _id: false }
);

const observationPromptSchema = new Schema(
	{
		key: { type: String, required: true },
		label: String,
		helpText: String
	},
	{ _id: false }
);

const stepSchema = new Schema(
	{
		key: { type: String, required: true },
		number: Number,
		title: String,
		instructions: String,
		reagents: { type: [stepReagentSchema], default: [] },
		timing: {
			durationMinutes: Number,
			intervalMinutes: Number,
			temperatureC: Number,
			rpm: Number,
			notes: String
		},
		qcCheckpoints: { type: [qcCheckpointSchema], default: [] },
		observationPrompts: { type: [observationPromptSchema], default: [] }
	},
	{ _id: false }
);

const postProtocolAssaySchema = new Schema(
	{
		key: { type: String, required: true },
		label: String,
		instructions: String,
		readings: { type: [qcCheckpointSchema], default: [] }
	},
	{ _id: false }
);

const versionEntrySchema = new Schema(
	{
		version: Number,
		changedAt: Date,
		changedBy: { _id: String, username: String },
		notes: String
	},
	{ _id: false }
);

const reagentProtocolTemplateSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		name: { type: String, required: true },
		slug: { type: String, required: true },
		version: { type: Number, default: 1 },
		status: { type: String, enum: ['draft', 'active', 'retired'], default: 'draft' },
		category: { type: String, enum: ['rnd', 'cartridge-prep', 'other'], default: 'rnd' },
		description: String,
		sourceSpreadsheet: String,

		parameters: { type: [parameterSchema], default: [] },
		ratios: { type: [ratioSchema], default: [] },
		materials: { type: [materialSchema], default: [] },
		steps: { type: [stepSchema], default: [] },
		postProtocolAssays: { type: [postProtocolAssaySchema], default: [] },

		outputSpec: {
			productName: String,
			expectedConcentration: Number,
			concentrationUnit: String,
			expectedVolume: Number,
			volumeUnit: String
		},

		versionHistory: { type: [versionEntrySchema], default: [] },
		createdBy: { _id: String, username: String }
	},
	{ timestamps: true }
);

reagentProtocolTemplateSchema.index({ slug: 1, version: 1 }, { unique: true });
reagentProtocolTemplateSchema.index({ status: 1, category: 1 });

export const ReagentProtocolTemplate =
	mongoose.models.ReagentProtocolTemplate ||
	mongoose.model(
		'ReagentProtocolTemplate',
		reagentProtocolTemplateSchema,
		'reagent_protocol_templates'
	);
