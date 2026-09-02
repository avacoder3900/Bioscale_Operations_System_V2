import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const partDefinitionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	partNumber: String, name: String, description: String, category: String,
	supplier: String, manufacturer: String, vendorPartNumber: String,
	unitCost: String, unitOfMeasure: String, leadTimeDays: Number,
	minimumOrderQty: Number, hazardClass: String, certifications: Schema.Types.Mixed,
	expirationDate: Date, msdsFileId: String,
	inspectionPathway: String, scanRequired: Boolean,
	inventoryCount: { type: Number, default: 0 },
	sortOrder: { type: Number, default: 0 },
	isActive: { type: Boolean, default: true },
	sampleSize: { type: Number, default: 0 },
	percentAccepted: { type: Number, default: 100 },
	createdBy: String,
	bomType: { type: String, enum: ['spu', 'cartridge'] },
	// Used-part variant (SPU-INV-09): set to the pristine part's _id. Variants
	// carry their own inventoryCount; creating one never touches the base count.
	usedVariantOf: String,
	// Subassembly (SPU-INV-09): a special grouping of parts with its own count.
	// Loose child counts are never double-reported — "tied up in subassemblies"
	// is computed as subCount × quantity per child.
	isSubassembly: { type: Boolean, default: false },
	components: {
		type: [{
			_id: false,
			partDefinitionId: String,
			partNumber: String,
			name: String,
			quantity: { type: Number, default: 1 }
		}],
		default: undefined
	},
	supplierPartNumber: String,
	quantityPerUnit: Number,
	barcode: String, // primary scannable barcode label for this part
	altBarcodes: { type: [String], default: undefined }, // additional valid scan labels (e.g. line-side bin labels), stored lowercase
	// Per-barcode (bin/label) quantities from physical counts. Each entry is one
	// physical label on a bin of this part; inventoryCount stays the rolled-up total.
	barcodeCounts: {
		type: [{
			_id: false,
			barcode: String, // lowercase, like barcode/altBarcodes
			quantity: Number,
			countedAt: Date,
			countedBy: String
		}],
		default: undefined
	},
	lastPhysicalCountAt: Date,
	lastBoxSyncAt: Date
}, { timestamps: true });

partDefinitionSchema.index({ partNumber: 1 }, { unique: true });
partDefinitionSchema.index({ barcode: 1 }, { unique: true, sparse: true });
partDefinitionSchema.index({ altBarcodes: 1 }, { sparse: true });
partDefinitionSchema.index({ bomType: 1 });

export const PartDefinition = mongoose.models.PartDefinition || mongoose.model('PartDefinition', partDefinitionSchema, 'part_definitions');
