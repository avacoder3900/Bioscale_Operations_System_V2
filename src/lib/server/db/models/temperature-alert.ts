import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const temperatureAlertSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	sensorId: { type: String, required: true, index: true },
	sensorName: String,
	equipmentId: String,
	alertType: {
		type: String,
		enum: ['high_temp', 'low_temp', 'lost_connection'],
		required: true
	},
	threshold: Number,
	actualValue: Number,
	timestamp: { type: Date, required: true },
	acknowledged: { type: Boolean, default: false },
	acknowledgedBy: {
		_id: String,
		username: String
	},
	acknowledgedAt: Date
}, { timestamps: true });

temperatureAlertSchema.index({ acknowledged: 1, timestamp: -1 });
temperatureAlertSchema.index({ equipmentId: 1, acknowledged: 1 });

export const TemperatureAlert = mongoose.models.TemperatureAlert
	|| mongoose.model('TemperatureAlert', temperatureAlertSchema, 'temperature_alerts');
