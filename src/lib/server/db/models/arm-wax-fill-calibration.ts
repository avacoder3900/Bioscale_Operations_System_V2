import mongoose, { Schema } from 'mongoose';

/**
 * ArmWaxFillCalibration — per OT-2 (`_id` = OpentronsRobot._id): the two
 * taught deck points the arm wax fill needs.
 *
 *   scanPosition  where the gantry-mounted barcode scanner reads the single
 *                 cart. Mirrored into a one-slot OpentronsScannerPositionSet
 *                 (`scanPositionSetId`) so the production sweep code reads it.
 *   cartLocation  the rim of the cart's FIRST wax hole (row 1, gate 4) on the
 *                 arm's stage, TIP-NEUTRAL: the operator picks up a tip,
 *                 probes it on the tip calibrator, jogs the tip onto the rim,
 *                 and x/y are stored as (live - that tip's probe adjust) -
 *                 the same convention as the deck holes taught in the Deck
 *                 Calibration Studio. `live` keeps what the robot reported and
 *                 `tipAdjust` the probe, so the save can always be audited.
 *                 Sent to the stage protocol as arm_cart_x / y / z, which adds
 *                 its own tip's probe adjust back.
 *
 *   dispenseDepth how far BELOW that rim the tip end sits when wax is dispensed
 *                 (negative = hover above it) — the stage protocol's
 *                 `dispense_depth`. Taught by jogging a tip to the height over
 *                 the first hole and saving; stored as rim z − live z.
 *   stageRotationDeg / stageJumpHeightMm  the cart's rotation on the stage and the
 *                 travel clearance over the rim (`arm_cart_rotation_deg`,
 *                 `stage_jump_height`).
 *
 * All taught on the Robot Arm → Stage calibration tab from a maintenance run:
 * jog, save the robot's own XYZ (plus the tip probe for the cart location).
 */
const pointSchema = new Schema(
	{
		x: { type: Number, required: true },
		y: { type: Number, required: true },
		z: { type: Number, required: true },
		taughtAt: Date,
		taughtBy: { _id: String, username: String },
		testScanBarcode: String,
		testScannedAt: Date,
		/** Cart location only: the probe adjust of the tip it was taught with (x/y above are live - this). */
		tipAdjust: { x: Number, y: Number },
		/** Cart location only: the robot's reported position at save time, before the adjust was removed. */
		live: { x: Number, y: Number, z: Number },
		/** Cart location only: the rack position the teaching tip came from. */
		tipWell: String
	},
	{ _id: false }
);

const armWaxFillCalibrationSchema = new Schema(
	{
		_id: { type: String, required: true }, // OpentronsRobot._id
		scanPosition: pointSchema,
		scanPositionSetId: String,
		cartLocation: pointSchema,
		dispenseDepth: {
			mm: Number, // positive = below the rim, negative = hover
			liveZ: Number, // the tip end's reported Z when it was taught
			taughtAt: Date,
			taughtBy: { _id: String, username: String }
		},
		stageRotationDeg: { type: Number, default: 0 },
		stageJumpHeightMm: { type: Number, default: 60 },
		pipetteMount: { type: String, enum: ['left', 'right'], default: 'left' },
		pipetteName: String,
		updatedBy: { _id: String, username: String }
	},
	{ timestamps: true }
);

export const ArmWaxFillCalibration =
	mongoose.models.ArmWaxFillCalibration ||
	mongoose.model('ArmWaxFillCalibration', armWaxFillCalibrationSchema, 'arm_wax_fill_calibrations');
