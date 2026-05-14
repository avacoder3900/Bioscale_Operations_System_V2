import mongoose, { Schema } from 'mongoose';

/**
 * Experiment — research-v2 collection, shared Mongo Atlas with BIMS.
 *
 * BIMS does NOT write to experiments. This model exists so Ask BIMS Phase E
 * tools (list_experiments, find_experiment, get_experiment_arm_cartridges)
 * can read research-side data via direct Mongoose queries instead of an HTTP
 * round-trip to research-v2's /api/agent/* endpoints.
 *
 * Schema is loose (strict: false) so any fields research writes are visible
 * without us needing to mirror the full research-v2 schema. Field names below
 * are the ones our tools project explicitly.
 */

const armCartridgeSchema = new Schema(
	{
		barcode: String,
		status: String,
		quantity: Number,
		quantityA: Number,
		quantityB: Number,
		quantityC: Number,
		sampleId: String,
		sampleIdA: String,
		sampleIdB: String,
		sampleIdC: String,
		sampleLabel: String,
		sampleLabelA: String,
		sampleLabelB: String,
		sampleLabelC: String
	},
	{ _id: false }
);

const armSchema = new Schema(
	{
		name: String,
		description: String,
		assayId: String,
		assayName: String,
		splitQuantity: Boolean,
		cartridges: { type: [armCartridgeSchema], default: [] }
	},
	{ _id: false }
);

const experimentSchema = new Schema(
	{
		_id: { type: String },
		status: String,
		statusUpdatedOn: String,
		program: String,
		folderId: String,
		name: String,
		description: String,
		nextSerialNumber: Number,
		arms: { type: [armSchema], default: [] },
		selected: { type: [String], default: [] }
	},
	{ strict: false, timestamps: true }
);

experimentSchema.index({ program: 1, name: 1 });
experimentSchema.index({ status: 1 });
experimentSchema.index({ updatedAt: -1 });

export const Experiment =
	mongoose.models.Experiment ||
	mongoose.model('Experiment', experimentSchema, 'experiments');
