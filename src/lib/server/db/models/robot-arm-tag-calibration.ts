import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — AprilTag vision calibration (ARM-05). Replaces ARM-04's
 * `robot_arm_vision_calibrations` (left in Mongo, no longer read).
 *
 * Taken with the arm parked at home: one detection on the Pi, keeping every
 * registered tag it found — where it is on the picture, its pose relative to
 * the camera (mm, rotation), and the D415's depth to it when available. Plus
 * the follower's encoder steps (and load/temperature) read on both sides of
 * that frame, the target for Return to home. A save needs both servos and camera.
 *
 * One `active` calibration per camera. Recalibrating supersedes the previous
 * one (kept for history, never edited).
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const poseSchema = new Schema(
	{
		/** Tag centre in the camera frame, mm. */
		t: { type: [Number], required: true },
		/** 3×3 rotation, row-major. */
		R: { type: [Number], required: true },
		reprojPx: { type: Number, default: null }
	},
	{ _id: false }
);

const tagSchema = new Schema(
	{
		markerId: { type: String, required: true },
		tagId: { type: Number, required: true },
		/** Name/group/role/size as they were at calibration time, so history reads true after an edit. */
		name: { type: String, required: true },
		group: { type: String, default: null },
		role: { type: String, enum: ['fixed', 'arm'], required: true },
		sizeMm: { type: Number, required: true },
		/** Normalised [x, y]. */
		center: { type: [Number], required: true },
		corners: { type: [[Number]], default: [] },
		pose: { type: poseSchema, default: null },
		depthMm: { type: Number, default: null }
	},
	{ _id: false }
);

const resultSchema = new Schema(
	{
		markerId: String,
		tagId: Number,
		name: String,
		status: String,
		offMm: Number,
		offDeg: Number
	},
	{ _id: false }
);

/** One servo at home, as the Pi reported it (load/temp/voltage/torque null when only /pose answered). */
const servoReadingSchema = new Schema(
	{
		sid: { type: Number, required: true },
		steps: { type: Number, required: true },
		load: { type: Number, default: null },
		temperatureC: { type: Number, default: null },
		voltage: { type: Number, default: null },
		torque: { type: Boolean, default: null }
	},
	{ _id: false }
);

const strainedSchema = new Schema(
	{
		sid: Number,
		load: Number,
		temperatureC: Number,
		reason: String // 'high_load' | 'hot'
	},
	{ _id: false }
);

const robotArmTagCalibrationSchema = new Schema(
	{
		_id: { type: String, required: true },
		cameraName: { type: String, required: true },
		status: { type: String, enum: ['active', 'superseded'], default: 'active' },
		capturedAt: { type: Date, required: true },
		capturedBy: { type: operatorRef },
		note: { type: String, default: null },
		frameWidth: { type: Number, required: true },
		frameHeight: { type: Number, required: true },
		/** Camera intrinsics the poses were computed with. `source`: realsense | env | nominal. */
		intrinsics: {
			fx: Number,
			fy: Number,
			cx: Number,
			cy: Number,
			source: String
		},
		detector: { type: String, default: null },
		/** data: URL JPEG, ~480 px wide. */
		thumbnailDataUrl: { type: String, default: null },
		/** R2 key of the full calibration frame, when the upload succeeded. */
		referenceImageKey: { type: String, default: null },
		tags: { type: [tagSchema], default: [] },
		tolerances: {
			positionMm: { type: Number, required: true },
			angleDeg: { type: Number, required: true },
			pixel: { type: Number, required: true }
		},
		/**
		 * servo id → encoder steps at home, servos 1–5. Required since the save
		 * relies on servos + camera; null only on calibrations taken before that.
		 */
		jointSteps: { type: Map, of: Number, default: null },
		/** Every servo at home, read right after the frame; the load baseline for checks. */
		servos: { type: [servoReadingSchema], default: [] },
		/** 'servos' (GET /servos, with load/temp) or 'pose' (GET /pose, steps only). */
		servoSource: { type: String, default: null },
		/** Largest encoder change between the reads before and after the frame (≤ HOME_STEP_TOLERANCE). */
		captureDriftSteps: { type: Number, default: null },
		/**
		 * Return-to-home settings: servo 1's safe range (± steps of home; beyond
		 * it home freezes and drops torque) and how far the mouth opens first.
		 * Editable on the Vision tab; carried forward to the next calibration.
		 */
		homing: {
			baseRangeSteps: { type: Number, default: null },
			gripperOpenSteps: { type: Number, default: null }
		},
		/** Run id of a Return-to-home loop the operator stopped; the attempt in progress checks it before every jog. */
		homeStopRunId: { type: String, default: null },
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
			cameraShiftMm: Number,
			markers: [resultSchema],
			strained: [strainedSchema]
		}
	},
	{ minimize: false }
);

robotArmTagCalibrationSchema.index({ cameraName: 1, status: 1 });

export const RobotArmTagCalibration =
	mongoose.models.RobotArmTagCalibration ||
	mongoose.model('RobotArmTagCalibration', robotArmTagCalibrationSchema, 'robot_arm_tag_calibrations');
