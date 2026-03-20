import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const operatorRef = { _id: String, username: String };

const calibrationRecordSchema = new Schema({
	_id: { type: String, default: () => generateId() },

	equipmentId: { type: String, required: true, index: true },
	equipmentType: { type: String, required: true },

	calibrationDate: { type: Date, required: true },
	nextCalibrationDue: { type: Date, required: true, index: true },

	performedBy: operatorRef,

	results: { type: Schema.Types.Mixed },

	status: {
		type: String,
		enum: ['pass', 'fail', 'due'],
		required: true,
		default: 'pass',
		index: true
	},

	notes: String,

	certificateUrl: String
}, { timestamps: true });

calibrationRecordSchema.index({ equipmentId: 1, calibrationDate: -1 });
calibrationRecordSchema.index({ nextCalibrationDue: 1, status: 1 });

export const CalibrationRecord = mongoose.models.CalibrationRecord ||
	mongoose.model('CalibrationRecord', calibrationRecordSchema, 'calibration_records');
