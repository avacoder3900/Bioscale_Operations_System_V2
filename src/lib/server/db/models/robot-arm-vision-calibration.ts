import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — vision calibration (ARM-04). Replaces ARM-03's single
 * `robot_arm_home_calibrations` record.
 *
 * Taken with the arm parked at home: the operator froze one camera frame and
 * dragged a virtual marker onto every sticker in it. Stored per placement:
 * where the sticker is (normalised to the frame), the colour sampled from it
 * (what tracking matches), and the camera's depth to it when the camera
 * reports depth. Also the follower's encoder steps at that moment, so Return
 * to home has a target.
 *
 * One `active` calibration per camera. Recalibrating supersedes the previous
 * one (kept for history, never edited) — needed whenever the camera moves or
 * anything about the arm or its surroundings changes.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });
const rgb = new Schema({ r: Number, g: Number, b: Number }, { _id: false });

const placementSchema = new Schema(
	{
		markerId: { type: String, required: true },
		/** Name/group as they were at calibration time, so history reads true after a rename. */
		name: { type: String, required: true },
		group: { type: String, default: null },
		color: { type: rgb, required: true },
		x: { type: Number, required: true },
		y: { type: Number, required: true },
		depthMm: { type: Number, default: null }
	},
	{ _id: false }
);

const markerResultSchema = new Schema(
	{
		markerId: String,
		name: String,
		status: String,
		distance: Number,
		depthDeltaMm: Number
	},
	{ _id: false }
);

const robotArmVisionCalibrationSchema = new Schema(
	{
		_id: { type: String, required: true },
		cameraName: { type: String, required: true },
		status: { type: String, enum: ['active', 'superseded'], default: 'active' },
		capturedAt: { type: Date, required: true },
		capturedBy: { type: operatorRef },
		note: { type: String, default: null },
		/** Pixel size of the calibration frame. */
		frameWidth: { type: Number, required: true },
		frameHeight: { type: Number, required: true },
		/** data: URL JPEG, ~480 px wide, so the page can show the reference without R2. */
		thumbnailDataUrl: { type: String, default: null },
		/** R2 key of the full calibration frame, when the upload succeeded. */
		referenceImageKey: { type: String, default: null },
		placements: { type: [placementSchema], default: [] },
		/** Whether the camera reported depth when this was taken. */
		depthAvailable: { type: Boolean, default: false },
		tolerances: {
			/** Fraction of frame width. */
			position: { type: Number, required: true },
			depthMm: { type: Number, required: true }
		},
		/** servo id → encoder steps at home, servos 1–5; null when the arm could not be read. */
		jointSteps: { type: Map, of: Number, default: null },
		pose: { x_mm: Number, y_mm: Number, z_mm: Number },
		supersededAt: { type: Date, default: null },
		supersededBy: { type: String, default: null },
		lastCheck: {
			at: Date,
			by: operatorRef,
			kind: String, // 'check' | 'return' | 'agent'
			verdict: String,
			visionVerdict: String,
			residualMax: Number,
			markers: [markerResultSchema]
		}
	},
	{ minimize: false }
);

robotArmVisionCalibrationSchema.index({ cameraName: 1, status: 1 });

export const RobotArmVisionCalibration =
	mongoose.models.RobotArmVisionCalibration ||
	mongoose.model('RobotArmVisionCalibration', robotArmVisionCalibrationSchema, 'robot_arm_vision_calibrations');
