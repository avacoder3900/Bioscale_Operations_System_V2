import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

// An optical-confirmation validation cartridge: a known-good assay cartridge
// assigned for running on an SPU's reader optics as a release validation step.
//
// Design decision (2026-06-22): the runnable program is SNAPSHOTTED onto this
// document at assign time, not merely referenced. `bcode` is a frozen copy of
// the AssayDefinition's BCODE ({ deviceParams, code[] }) as it existed when the
// cartridge was assigned. Later edits to the assay never change an already-
// assigned validation cartridge — the cartridge IS the complete, reproducible
// run record. The `assay` ref is kept only for traceability.
const opticalTestCartridgeSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	barcode: { type: String, required: true },
	serialNumber: String,

	// Traceability ref back to the source assay (NOT used to run — see bcode).
	assay: {
		_id: { type: String, required: true },
		skuCode: String,
		name: String,
		// version/revision of the assay at snapshot time, if available
		version: Number
	},

	// Frozen, self-contained runnable program. Everything the SPU reader needs:
	//   deviceParams: { integrationTime, gain, ledPower, delayBetweenSensorReadings }
	//   code: [ { command, params } ... ]  (Start Test / Delay / Move Microns / ...)
	bcode: {
		deviceParams: Schema.Types.Mixed,
		code: { type: [Schema.Types.Mixed], default: [] }
	},
	// Snapshot metadata so we can detect drift from the live assay later.
	bcodeSnapshotAt: Date,
	duration: Number, // expected run duration (seconds), copied from the assay

	groupId: String,
	status: {
		type: String,
		enum: ['available', 'in_use', 'depleted', 'expired', 'quarantine', 'disposed'],
		default: 'available'
	},

	expirationDate: Date,
	notes: String,
	isActive: { type: Boolean, default: true },

	usageLog: [{
		_id: { type: String, default: () => generateId() },
		action: {
			type: String,
			enum: ['registered', 'scanned', 'attached', 'used', 'status_changed', 'group_changed', 'depleted', 'disposed']
		},
		previousValue: String,
		newValue: String,
		spuId: String,
		validationSessionId: String,
		notes: String,
		performedBy: { _id: String, username: String },
		performedAt: Date
	}],

	createdBy: String
}, { timestamps: true });

opticalTestCartridgeSchema.index({ barcode: 1 });
opticalTestCartridgeSchema.index({ groupId: 1 });
opticalTestCartridgeSchema.index({ status: 1 });
opticalTestCartridgeSchema.index({ 'assay._id': 1 });

export const OpticalTestCartridge =
	mongoose.models.OpticalTestCartridge ||
	mongoose.model('OpticalTestCartridge', opticalTestCartridgeSchema, 'optical_test_cartridges');
