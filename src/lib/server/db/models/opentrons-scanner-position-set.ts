import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

/**
 * OpentronsScannerPositionSet
 *
 * Saved deck-coordinate set for the gantry-mounted barcode scanner. The
 * production "Scan Cartridges" sweep loops these positions in slotIndex
 * order, moving the scanner head over each cartridge barcode.
 *
 * Multiple sets may exist per robot (e.g. different deck layouts); exactly
 * one per robot is marked isDefault and used at run time when no explicit
 * set is named.
 */

const positionSchema = new Schema(
	{
		slotIndex: { type: Number, required: true }, // 0..positionCount-1
		x: { type: Number, required: true },
		y: { type: Number, required: true },
		z: { type: Number, required: true },
		// Optional last test-scan barcode captured during teaching, for sanity.
		testScanBarcode: String,
		testScannedAt: Date
	},
	{ _id: false }
);

const opentronsScannerPositionSetSchema = new Schema(
	{
		_id: { type: String, default: () => generateId() },
		robotId: { type: String, required: true, index: true },
		title: { type: String, required: true },
		positionCount: { type: Number, required: true, min: 1 },
		positions: { type: [positionSchema], default: [] },
		isDefault: { type: Boolean, default: false, index: true },
		// Mount metadata captured at teach time so the sweep uses the same
		// pipette mount that was used during calibration.
		pipetteMount: { type: String, enum: ['left', 'right'], default: 'left' },
		pipetteName: String,
		notes: String,
		calibratedBy: {
			_id: String,
			username: String
		},
		calibratedAt: Date,
		updatedBy: {
			_id: String,
			username: String
		}
	},
	{ timestamps: true }
);

opentronsScannerPositionSetSchema.index(
	{ robotId: 1, title: 1 },
	{ unique: true, name: 'robotId_title_unique' }
);
opentronsScannerPositionSetSchema.index({ robotId: 1, isDefault: 1 });

export const OpentronsScannerPositionSet =
	mongoose.models.OpentronsScannerPositionSet ||
	mongoose.model(
		'OpentronsScannerPositionSet',
		opentronsScannerPositionSetSchema,
		'opentrons_scanner_position_sets'
	);
