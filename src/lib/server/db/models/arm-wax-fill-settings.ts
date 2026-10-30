import mongoose, { Schema } from 'mongoose';

/**
 * ArmWaxFillSettings — one document (`_id: 'default'`) for the robot-arm wax
 * fill line (/manufacturing/cart-mfg/robot-arm/wax-fill).
 *
 * The arm feeds ONE cartridge at a time to an OT-2. With the stage protocol
 * (protocols/Wax_Filling_GEN7_ArmStage.py, which declares arm_cart_x/y/z)
 * the fill lands on the taught cart location (ArmWaxFillCalibration, taught
 * on the Stage calibration tab);
 * with the ordinary carriage protocol it fills `cartPosition` on `deckId`
 * (the legacy stopgap). The grab, withdraw and fail animations are Animate
 * move sets or sequences, chosen once and kept: the page only lets them change
 * after an explicit "Change animations", so a run never asks for them again.
 * The fail animation plays instead of the fill when the scan fails (the fail
 * route, see $lib/server/arm-wax-fill); it may be the same as the withdraw.
 *
 * 2026-10-30 (the speed work): `channels` picks which rows of the cart the
 * stage protocol fills (sent as the carriage line's row_pattern_0/1/2);
 * `grabDuringProbe` lets the first grab start at 'ARM PROBING' instead of
 * 'ARM CALIBRATED'; `chainGrab` plays a cart's withdraw and the next cart's
 * grab as one arm path.
 */
const animationRefSchema = new Schema(
	{
		kind: { type: String, enum: ['move_set', 'sequence'], required: true },
		id: { type: String, required: true },
		// Denormalised for display when the move set is later archived or renamed.
		name: String
	},
	{ _id: false }
);

const armWaxFillSettingsSchema = new Schema(
	{
		_id: { type: String, default: 'default' },
		/** OpentronsRobot._id of the OT-2 the arm feeds. */
		robotId: String,
		/** 1-based deck position the protocol fills (`resume_cartridge`), default 1. */
		cartPosition: { type: Number, default: 1 },
		/** Optional wax lot stamped on every cycle's wax run (traceability only). */
		waxSourceLot: String,
		/** Unknown barcodes become synthetic backed carts (same as the wax wizard's test mode). */
		testMode: { type: Boolean, default: false },
		/**
		 * Which channels (rows of four wax holes) the stage fill does. On the stage the
		 * cart has one taught orientation: C = row X (the first row from the taught
		 * hole), B = row W, A = row V. Sent to the protocol as row_pattern_0/1/2.
		 */
		channels: {
			c: { type: Boolean, default: true },
			b: { type: Boolean, default: true },
			a: { type: Boolean, default: true }
		},
		/** The arm's first grab may start while the OT-2 probes its tip ('ARM PROBING'), not only after ('ARM CALIBRATED'). */
		grabDuringProbe: { type: Boolean, default: true },
		/** Between carts the withdraw and the next grab play as ONE arm path (one play, no tail between them). */
		chainGrab: { type: Boolean, default: true },
		grabAnimation: animationRefSchema,
		withdrawAnimation: animationRefSchema,
		/** Plays when a cycle takes the fail route (today: the scan failed). May equal the withdraw animation. */
		failAnimation: animationRefSchema,
		animationsChangedAt: Date,
		animationsChangedBy: { _id: String, username: String },
		updatedBy: { _id: String, username: String }
	},
	{ timestamps: true }
);

export const ArmWaxFillSettings =
	mongoose.models.ArmWaxFillSettings ||
	mongoose.model('ArmWaxFillSettings', armWaxFillSettingsSchema, 'arm_wax_fill_settings');
