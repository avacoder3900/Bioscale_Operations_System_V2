import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — camera-verified HOME calibration (one record, `_id: 'default'`).
 *
 * Captured on the Control page once the operator has placed the arm at its
 * zero/home: the follower's joint encoder steps (servos 1–5) plus what the arm
 * camera saw at that instant — a small greyscale signature used to verify a
 * later return-to-home, and a thumbnail so the page can show the reference
 * without touching R2. The full-resolution frame goes to R2 best-effort.
 *
 * Recalibrate only when the camera or the arm's setup is moved; the record
 * is otherwise meant to outlive any number of runs.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const robotArmHomeCalibrationSchema = new Schema({
	_id: { type: String, default: 'default' },
	capturedAt: { type: Date, required: true },
	capturedBy: { type: operatorRef },
	/** servo id (as a string key) → encoder steps, servos 1–5 */
	jointSteps: { type: Map, of: Number, required: true },
	pose: {
		x_mm: Number,
		y_mm: Number,
		z_mm: Number
	},
	/** Pi camera name the reference was taken with (e.g. "external"). */
	cameraName: { type: String, default: null },
	/** 32×24 greyscale in [0,1], row-major; null when no camera frame was available. */
	signature: { type: [Number], default: null },
	signatureWidth: { type: Number, default: null },
	signatureHeight: { type: Number, default: null },
	/** data: URL JPEG, ~240 px wide, for the page. */
	thumbnailDataUrl: { type: String, default: null },
	/** R2 key of the full-resolution reference frame, when the upload succeeded. */
	referenceImageKey: { type: String, default: null },
	note: { type: String, default: null },
	/** Last camera/encoder check against this calibration (any outcome). */
	lastCheck: {
		at: Date,
		by: operatorRef,
		verdict: String,
		similarity: Number,
		residualMax: Number,
		kind: String // 'return' | 'check'
	}
}, { minimize: false });

export const RobotArmHomeCalibration =
	mongoose.models.RobotArmHomeCalibration ||
	mongoose.model('RobotArmHomeCalibration', robotArmHomeCalibrationSchema, 'robot_arm_home_calibrations');
