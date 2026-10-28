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
 * (the legacy stopgap). The grab and withdraw animations are Animate move
 * sets or sequences, chosen once and kept: the page only lets them change
 * after an explicit "Change animations", so a run never asks for them again.
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
		grabAnimation: animationRefSchema,
		withdrawAnimation: animationRefSchema,
		animationsChangedAt: Date,
		animationsChangedBy: { _id: String, username: String },
		updatedBy: { _id: String, username: String }
	},
	{ timestamps: true }
);

export const ArmWaxFillSettings =
	mongoose.models.ArmWaxFillSettings ||
	mongoose.model('ArmWaxFillSettings', armWaxFillSettingsSchema, 'arm_wax_fill_settings');
