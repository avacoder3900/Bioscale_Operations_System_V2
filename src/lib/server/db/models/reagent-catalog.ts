import mongoose, { Schema } from 'mongoose';

/**
 * ReagentCatalog — research-v2 collection, shared Mongo Atlas.
 *
 * BIMS does NOT write to reagent_catalog. Read-only mirror for Ask BIMS Phase E
 * tools (list_reagent_catalog, find_reagent_catalog).
 *
 * Variants subdoc: parameterValues are IMMUTABLE after variant creation per
 * DOMAIN-26-REAGENT-VARIANTS. Inventory rollups MUST group by
 * (catalogId, variantKey) — never pool different variants. The
 * count_inventory_by_variant tool enforces this.
 */

const variantSchema = new Schema(
	{
		key: String,
		label: String,
		description: String,
		parameterValues: Schema.Types.Mixed,
		createdAt: Date,
		isActive: Boolean
	},
	{ _id: false }
);

const reagentCatalogSchema = new Schema(
	{
		_id: String,
		name: String,
		parentId: String,
		type: String,
		category: String,
		subcategory: String,
		catalogNumber: String,
		manufacturer: String,
		defaultConcentration: Number,
		defaultConcentrationUnit: String,
		molecularWeight: Number,
		storageConditions: String,
		costPerUnit: Number,
		costUnitDescription: String,
		description: String,
		tags: [String],
		protocolDefinitionId: String,
		keyParameters: Schema.Types.Mixed,
		variants: { type: [variantSchema], default: [] }
	},
	{ strict: false, timestamps: true }
);

export const ReagentCatalog =
	mongoose.models.ReagentCatalog ||
	mongoose.model('ReagentCatalog', reagentCatalogSchema, 'reagent_catalog');
