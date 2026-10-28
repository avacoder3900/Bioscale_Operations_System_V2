import mongoose, { Schema } from 'mongoose';

/**
 * ArmWaxFillCalibration — per OT-2 (`_id` = OpentronsRobot._id): the two
 * taught deck points the arm wax fill needs.
 *
 *   scanPosition  where the gantry-mounted barcode scanner reads the single
 *                 cart. Mirrored into a one-slot OpentronsScannerPositionSet
 *                 (`scanPositionSetId`) so the production sweep code reads it.
 *   cartLocation  the pipette over the cart's first well. Sent to the protocol
 *                 as `arm_cart_x` / `arm_cart_y` / `arm_cart_z` when its
 *                 parameter schema declares them; until then it is recorded
 *                 for the protocol variant that will.
 *
 * Taught the same way as the barcode-positions page: a maintenance run, jog,
 * save the robot's own XYZ.
 */
const pointSchema = new Schema(
	{
		x: { type: Number, required: true },
		y: { type: Number, required: true },
		z: { type: Number, required: true },
		taughtAt: Date,
		taughtBy: { _id: String, username: String },
		testScanBarcode: String,
		testScannedAt: Date
	},
	{ _id: false }
);

const armWaxFillCalibrationSchema = new Schema(
	{
		_id: { type: String, required: true }, // OpentronsRobot._id
		scanPosition: pointSchema,
		scanPositionSetId: String,
		cartLocation: pointSchema,
		pipetteMount: { type: String, enum: ['left', 'right'], default: 'left' },
		pipetteName: String,
		updatedBy: { _id: String, username: String }
	},
	{ timestamps: true }
);

export const ArmWaxFillCalibration =
	mongoose.models.ArmWaxFillCalibration ||
	mongoose.model('ArmWaxFillCalibration', armWaxFillCalibrationSchema, 'arm_wax_fill_calibrations');
