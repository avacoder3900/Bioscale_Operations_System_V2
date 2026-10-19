import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a registered sticker marker (ARM-04).
 *
 * One row per physical coloured sticker the operator has put on the arm or
 * its surroundings. Nothing here is predefined: the name ("Wrist", "Back of
 * Opentron", …) and the optional group ("Joint", "Environment", …) are
 * whatever the operator types. `color` is the nominal sticker colour used to
 * draw the marker; the colour tracking actually matches is re-sampled from the
 * camera at each calibration (lighting differs from the swatch), and lives on
 * the calibration's placement.
 *
 * Archived, never deleted: a calibration may still reference the marker.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmMarkerSchema = new Schema(
	{
		_id: { type: String, required: true },
		name: { type: String, required: true, trim: true },
		group: { type: String, default: null, trim: true },
		color: {
			type: new Schema({ r: Number, g: Number, b: Number }, { _id: false }),
			required: true
		},
		notes: { type: String, default: null },
		createdBy: { type: operatorRef },
		archivedAt: { type: Date, default: null },
		archivedBy: { type: operatorRef, default: null }
	},
	{ timestamps: true }
);

robotArmMarkerSchema.index({ archivedAt: 1, name: 1 });

export const RobotArmMarker =
	mongoose.models.RobotArmMarker || mongoose.model('RobotArmMarker', robotArmMarkerSchema, 'robot_arm_markers');
