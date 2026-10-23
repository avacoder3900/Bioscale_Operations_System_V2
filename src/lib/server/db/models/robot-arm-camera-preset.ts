import mongoose, { Schema } from 'mongoose';

/**
 * Robot arm — a named set of camera control values (exposure, gain, white
 * balance, ...) for the arm camera, kept in BIMS so settings that worked
 * under one lighting condition can be found and re-applied later.
 *
 * `values` is what gets written to the camera (control name → raw value);
 * `controls` is the camera's own report at capture time (ranges, defaults,
 * flags) so the preset still reads true if the camera or its driver changes.
 * `conditions` is where the preset was taken ("Shared office, blinds open");
 * it belongs beside the name because the right exposure depends on the light,
 * not on the camera. `kind` marks the camera's factory defaults apart from an
 * operator's tuning.
 *
 * Archived, never deleted: the audit log and progress notes refer to them.
 */
const operatorRef = new Schema({ _id: { type: String }, username: { type: String } }, { _id: false });

const controlSnapshotSchema = new Schema(
	{
		id: { type: String, required: true },
		type: { type: String, default: null },
		min: { type: Number, default: null },
		max: { type: Number, default: null },
		step: { type: Number, default: null },
		default: { type: Number, default: null },
		value: { type: Number, default: null },
		flags: { type: [String], default: [] },
		unit: { type: String, default: '' }
	},
	{ _id: false }
);

const robotArmCameraPresetSchema = new Schema(
	{
		_id: { type: String, required: true },
		cameraName: { type: String, required: true },
		name: { type: String, required: true, trim: true },
		/** Lighting / scene the values were taken under. */
		conditions: { type: String, default: null, trim: true },
		notes: { type: String, default: null },
		kind: { type: String, enum: ['camera-default', 'operator'], default: 'operator' },
		/** control name → raw value, as written to the camera. */
		values: { type: Map, of: Number, required: true },
		/** The camera's control report when the preset was saved. */
		controls: { type: [controlSnapshotSchema], default: [] },
		/** Which device reported the values (e.g. /dev/video4). */
		device: { type: String, default: null },
		createdBy: { type: operatorRef },
		lastAppliedAt: { type: Date, default: null },
		lastAppliedBy: { type: operatorRef, default: null },
		archivedAt: { type: Date, default: null },
		archivedBy: { type: operatorRef, default: null }
	},
	{ timestamps: true }
);

robotArmCameraPresetSchema.index({ cameraName: 1, archivedAt: 1, createdAt: -1 });

export const RobotArmCameraPreset =
	mongoose.models.RobotArmCameraPreset || mongoose.model('RobotArmCameraPreset', robotArmCameraPresetSchema, 'robot_arm_camera_presets');
