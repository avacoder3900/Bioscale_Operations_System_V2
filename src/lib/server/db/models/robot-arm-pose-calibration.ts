import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a pose's camera reference (ARM-09 verified poses).
 *
 * Taken with the arm sitting ON the pose exactly as a play lands it (Go to
 * pose, then capture): one AprilTag detection on the Pi — every registered
 * tag's picture position and pose relative to the camera — plus the
 * follower's encoder reading on both sides of that frame, and the pose's
 * goals at the time. A verified run checks each step against this with the
 * step's tolerances (`tolerances` here are the defaults for the pose; a
 * move-set keyframe can override them).
 *
 * One `active` reference per pose per camera; recapturing supersedes the
 * previous one (kept, never edited). Same shape as the home calibration
 * (robot-arm-tag-calibration.ts) so the same assessment code reads both.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const altPoseSchema = new Schema({ t: { type: [Number], required: true }, R: { type: [Number], required: true }, reprojPx: { type: Number, default: null } }, { _id: false });

const poseSchema = new Schema(
	{
		t: { type: [Number], required: true },
		R: { type: [Number], required: true },
		reprojPx: { type: Number, default: null },
		alt: { type: altPoseSchema, default: null }
	},
	{ _id: false }
);

const tagSchema = new Schema(
	{
		markerId: { type: String, required: true },
		tagId: { type: Number, required: true },
		name: { type: String, required: true },
		group: { type: String, default: null },
		role: { type: String, enum: ['fixed', 'arm'], required: true },
		sizeMm: { type: Number, required: true },
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
		offDeg: Number,
		offTiltDeg: Number,
		ambiguous: Boolean
	},
	{ _id: false }
);

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

const robotArmPoseCalibrationSchema = new Schema(
	{
		_id: { type: String, required: true },
		poseId: { type: String, required: true },
		/** The pose's name at capture, so history reads true after a rename. */
		poseName: { type: String, required: true },
		cameraName: { type: String, required: true },
		status: { type: String, enum: ['active', 'superseded'], default: 'active' },
		capturedAt: { type: Date, required: true },
		capturedBy: { type: operatorRef },
		note: { type: String, default: null },
		/** The pose's six goals when the reference was taken; a later edit of the pose makes the reference stale. */
		goals: { type: [Number], required: true },
		poseBasis: { type: String, enum: ['goal', 'reading'], default: 'goal' },
		frameWidth: { type: Number, required: true },
		frameHeight: { type: Number, required: true },
		intrinsics: { fx: Number, fy: Number, cx: Number, cy: Number, source: String },
		detector: { type: String, default: null },
		/** data: URL JPEG, ~480 px wide. */
		thumbnailDataUrl: { type: String, default: null },
		/** R2 key of the full reference frame, when the upload succeeded. */
		referenceImageKey: { type: String, default: null },
		tags: { type: [tagSchema], default: [] },
		/** Defaults for every step that uses this pose; set after looking at the live residuals. */
		tolerances: {
			positionMm: { type: Number, required: true },
			angleDeg: { type: Number, required: true },
			steps: { type: Number, required: true }
		},
		/** servo id → encoder steps with the arm on the pose, servos 1–5. */
		jointSteps: { type: Map, of: Number, required: true },
		servos: { type: [servoReadingSchema], default: [] },
		servoSource: { type: String, default: null },
		captureDriftSteps: { type: Number, default: null },
		supersededAt: { type: Date, default: null },
		supersededBy: { type: String, default: null },
		/** The most recent check without motion (Check now) or verified-run step against this reference. */
		lastCheck: {
			at: Date,
			by: operatorRef,
			kind: String, // 'check' | 'run'
			verdict: String,
			visionVerdict: String,
			residualMax: Number,
			residuals: { type: Map, of: Number, default: undefined },
			cameraShiftMm: Number,
			markers: [resultSchema],
			runId: String
		}
	},
	{ minimize: false }
);

robotArmPoseCalibrationSchema.index({ poseId: 1, status: 1 });
robotArmPoseCalibrationSchema.index({ cameraName: 1, status: 1 });

export const RobotArmPoseCalibration =
	mongoose.models.RobotArmPoseCalibration || mongoose.model('RobotArmPoseCalibration', robotArmPoseCalibrationSchema, 'robot_arm_pose_calibrations');
