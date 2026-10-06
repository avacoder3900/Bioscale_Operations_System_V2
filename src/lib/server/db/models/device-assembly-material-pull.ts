import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

// Append-only record of material pulled from inventory for a specific
// Device Assembly WI step. The stock movement itself is an
// InventoryTransaction (consumption) — this row ties that transaction back
// to the WI section/step/material so the page can show per-step history.

const deviceAssemblyMaterialPullSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	wiId: { type: String, required: true, index: true },
	wiVersion: { type: Number, default: null },
	sectionNumber: { type: Number, required: true },
	sectionTitle: { type: String, default: '' },
	stepId: { type: String, required: true, index: true },
	stepNumber: { type: Number, required: true },
	materialId: { type: String, default: null },
	partDefinitionId: { type: String, default: null },
	partNumber: { type: String, default: null },
	name: { type: String, default: '' },
	quantity: { type: Number, required: true },
	unit: { type: String, default: 'ea' },
	unitsBuilt: { type: Number, default: 1 },
	deviceSerial: { type: String, default: null },
	inventoryTransactionId: { type: String, default: null },
	previousQuantity: { type: Number, default: null },
	newQuantity: { type: Number, default: null },
	performedBy: {
		_id: { type: String, default: null },
		username: { type: String, default: null }
	},
	performedAt: { type: Date, default: Date.now },
	notes: { type: String, default: '' }
}, { timestamps: false });

deviceAssemblyMaterialPullSchema.index({ wiId: 1, performedAt: -1 });

applyImmutableMiddleware(deviceAssemblyMaterialPullSchema);

export const DeviceAssemblyMaterialPull =
	mongoose.models.DeviceAssemblyMaterialPull ||
	mongoose.model('DeviceAssemblyMaterialPull', deviceAssemblyMaterialPullSchema, 'device_assembly_material_pulls');
