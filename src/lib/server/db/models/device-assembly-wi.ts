import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// Device Assembly Work Instruction (Manufacturing → Device Assembly WI).
//
// One document per work instruction. The procedure is split into `sections`:
// number 0 is the "Cleaning & Setup" prerequisite block, numbers 1..N are the
// sub-assemblies (five by default). Every edit bumps `currentVersion` and
// appends an entry to `revisions` (append-only — see recordRevision()).
//
// Material consumption is NOT stored here: it goes through
// recordTransaction() → InventoryTransaction + DeviceAssemblyMaterialPull.

const imageSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	url: { type: String, required: true },
	alt: { type: String, default: '' },
	caption: { type: String, default: '' },
	storage: { type: String, enum: ['r2', 'mongo', 'inline', 'external'], default: 'r2' },
	addedAt: { type: Date, default: Date.now },
	addedBy: { type: String, default: null }
}, { _id: false });

const materialSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	// 'part' = consumable from the parts catalog (deducts from PartDefinition.inventoryCount)
	// 'tool' / 'aid' / 'supply' = required but never deducted automatically
	kind: { type: String, enum: ['part', 'tool', 'aid', 'supply'], default: 'part' },
	partNumber: { type: String, default: null },        // e.g. PT-SPU-044, TOOL-SPU-048
	partDefinitionId: { type: String, default: null },  // resolved link to PartDefinition
	name: { type: String, required: true },
	quantity: { type: Number, default: 1 },             // per device built
	unit: { type: String, default: 'ea' },              // ea, mm, drops…
	deductFromInventory: { type: Boolean, default: true },
	notes: { type: String, default: '' },
	rawText: { type: String, default: '' }              // original bullet text from the .docx
}, { _id: false });

const stepSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	stepNumber: { type: Number, required: true },
	title: { type: String, default: '' },
	instructionsHtml: { type: String, default: '' },
	instructionsText: { type: String, default: '' },
	images: { type: [imageSchema], default: [] },
	materials: { type: [materialSchema], default: [] },
	requiresEsd: { type: Boolean, default: false },
	dhrFields: { type: [String], default: [] }           // e.g. "Stepper Motor Serial Number"
}, { _id: false });

const sectionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	type: { type: String, enum: ['setup', 'subassembly'], default: 'subassembly' },
	number: { type: Number, required: true },           // 0 = setup, 1..N = Sub-Assembly N
	title: { type: String, default: '' },               // e.g. "Bottom (Pulley, Rail, Wi-Fi, etc.)"
	notesHtml: { type: String, default: '' },           // section-level notes from the doc
	materialsHtml: { type: String, default: '' },       // "Materials:" table preceding the steps (setup)
	steps: { type: [stepSchema], default: [] }
}, { _id: false });

const revisionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	version: { type: Number, required: true },
	label: { type: String, required: true },            // "v3"
	changeType: {
		type: String,
		enum: [
			'import', 'section_rename', 'step_add', 'step_edit', 'step_delete', 'step_move',
			'image_add', 'image_remove', 'image_edit', 'material_add', 'material_edit', 'material_remove',
			'metadata_edit'
		],
		required: true
	},
	summary: { type: String, required: true },
	location: {
		sectionNumber: { type: Number, default: null },
		sectionTitle: { type: String, default: null },
		stepNumber: { type: Number, default: null },
		stepId: { type: String, default: null }
	},
	before: { type: Schema.Types.Mixed, default: null },
	after: { type: Schema.Types.Mixed, default: null },
	changedBy: {
		_id: { type: String, default: null },
		username: { type: String, default: null }
	},
	changedAt: { type: Date, default: Date.now }
}, { _id: false });

const deviceAssemblyWISchema = new Schema({
	_id: { type: String, default: () => generateId() },
	documentNumber: { type: String, default: 'WIMF-SPU-01' },
	title: { type: String, default: 'Device Assembly Work Instruction' },
	assemblyNumber: { type: String, default: '' },      // AS-SPU-001
	status: { type: String, enum: ['draft', 'active', 'retired'], default: 'active' },
	currentVersion: { type: Number, default: 0 },
	frontMatter: {
		purposeHtml: { type: String, default: '' },
		scopeHtml: { type: String, default: '' },
		responsibilitiesHtml: { type: String, default: '' },
		definitions: { type: [String], default: [] },
		references: { type: [String], default: [] },
		generalNotesHtml: { type: String, default: '' }
	},
	sections: { type: [sectionSchema], default: [] },
	sourceFile: {
		originalFileName: { type: String, default: null },
		fileSize: { type: Number, default: null },
		mimeType: { type: String, default: null },
		uploadedAt: { type: Date, default: null },
		uploadedBy: { type: String, default: null },
		parserVersion: { type: String, default: null },
		warnings: { type: [String], default: [] }
	},
	revisions: { type: [revisionSchema], default: [] },
	createdBy: {
		_id: { type: String, default: null },
		username: { type: String, default: null }
	},
	lastChangedBy: {
		_id: { type: String, default: null },
		username: { type: String, default: null }
	},
	lastChangedAt: { type: Date, default: null }
}, { timestamps: true, optimisticConcurrency: true });

deviceAssemblyWISchema.index({ documentNumber: 1 }, { unique: true });

export const DeviceAssemblyWI =
	mongoose.models.DeviceAssemblyWI ||
	mongoose.model('DeviceAssemblyWI', deviceAssemblyWISchema, 'device_assembly_work_instructions');
