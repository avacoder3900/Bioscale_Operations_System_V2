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
		helpText: String,
		// Excel provenance (populated for flexible-mode templates parsed from .xlsx).
		// Empty/null for hand-built rigid templates. Stays so flexible-mode UIs can
		// echo the original Excel cell when rendering.
		cellRef: String,
		// Distinguishes user-input parameters from derived/calculated ones.
		// Defaults true; flexible-mode parsers may set false for cells that are
		// purely formula outputs.
		isInput: { type: Boolean, default: true }
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
		// Direct link to a ReagentCatalog row. Used by both rigid and flexible
		// modes when the material maps to a known catalog entry. Optional —
		// some materials (intermediates, ad-hoc) won't have a catalog match.
		catalogId: String,
		// Excel-import provenance: the formula used to compute the per-run
		// amount. Stored as a string expression; evaluated client-side at lot
		// time. Empty for rigid-mode templates.
		amountFormula: String,
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
		notes: String,
		// Pipetting metadata (carried over from research-v2 / Excel protocols).
		// All optional — populated where the protocol calls for specific pipette
		// + volume + frequency choreography.
		pipette: String, // 'P200', 'P1000', etc.
		volume: String, // free-form (e.g. "50 µL" or "0.5 mL")
		frequency: String, // e.g. "3x" — how many times to repeat the pipette action
		isIntermediate: { type: Boolean, default: false } // true when the reagent is just transferred through, not consumed
	},
	{ _id: false }
);

// Step content item — for flexible-mode templates that interleave instruction
// text and reagent rows in any order. Hand-built rigid templates can ignore
// (default to instructions first, then reagents block). When populated, the UI
// honors this order over the implicit one.
const stepContentItemSchema = new Schema(
	{
		type: { type: String, enum: ['instruction', 'reagent'], required: true },
		text: String,
		reagentIndex: Number
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
		// Flexible-mode sub-bullets under the main instructions text. Optional;
		// rigid templates can leave empty.
		substeps: { type: [String], default: [] },
		// Flexible-mode interleaved instruction/reagent ordering. Optional.
		contentOrder: { type: [stepContentItemSchema], default: undefined },
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

// One declared output of a protocol. A protocol may produce multiple physical
// products (e.g., a conjugation that yields both the conjugated reagent AND a
// supernatant aliquot to QC separately). Each output gets a catalog link so
// finalize knows where to file the produced tube.
const outputSpecSchema = new Schema(
	{
		key: { type: String, required: true }, // canonical id within the template (e.g. 'shelled-qd', 'wash-supernatant')
		productName: String, // human label
		catalogId: String, // ReagentCatalog._id — required for finalize to create inventory rows
		expectedConcentration: Number,
		concentrationUnit: String,
		expectedVolume: Number,
		volumeUnit: String,
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

		// 'rigid' = BIMS-authored, hand-built, fully typed, sacred-locking on
		// finalize. 'flexible' = research-v2-style, Excel-parsed, looser QC,
		// also sacred-locking on finalize (per unified rule "finalized = locked").
		// Distinguishes provenance and UI affordances, not behavior at runtime.
		mode: { type: String, enum: ['rigid', 'flexible'], default: 'rigid' },

		parameters: { type: [parameterSchema], default: [] },
		ratios: { type: [ratioSchema], default: [] },
		materials: { type: [materialSchema], default: [] },
		steps: { type: [stepSchema], default: [] },
		postProtocolAssays: { type: [postProtocolAssaySchema], default: [] },

		// Single-output legacy field — kept for back-compat with existing 6
		// rigid templates that already populated it. New templates and any
		// multi-output protocols should use outputSpecs[] below.
		outputSpec: {
			productName: String,
			catalogId: String, // added per unification — finalize needs this to create inventory rows
			expectedConcentration: Number,
			concentrationUnit: String,
			expectedVolume: Number,
			volumeUnit: String
		},

		// Multi-output spec. When populated, finalize prompts for one barcode
		// per output and creates one inventory row per output. Preferred over
		// outputSpec for new templates.
		outputSpecs: { type: [outputSpecSchema], default: [] },

		// Excel formula provenance — preserves the original cell graph from
		// the source spreadsheet for live cascade recalc in flexible-mode UIs.
		// Empty for rigid-mode templates. Schema.Types.Mixed because the cell
		// map shape is parser-defined (one key per cell reference).
		cellMap: { type: Schema.Types.Mixed, default: {} },

		versionHistory: { type: [versionEntrySchema], default: [] },
		createdBy: { _id: String, username: String }
	},
	{ timestamps: true }
);

reagentProtocolTemplateSchema.index({ slug: 1, version: 1 }, { unique: true });
reagentProtocolTemplateSchema.index({ status: 1, category: 1 });
reagentProtocolTemplateSchema.index({ mode: 1, status: 1 });
reagentProtocolTemplateSchema.index({ 'outputSpec.catalogId': 1 });
reagentProtocolTemplateSchema.index({ 'outputSpecs.catalogId': 1 });

export const ReagentProtocolTemplate =
	mongoose.models.ReagentProtocolTemplate ||
	mongoose.model(
		'ReagentProtocolTemplate',
		reagentProtocolTemplateSchema,
		'reagent_protocol_templates'
	);
