import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applyImmutableMiddleware } from '../middleware/immutable.js';

const temperatureReadingSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	sensorId: { type: String, required: true, index: true },
	sensorName: String,
	temperature: Number,
	humidity: Number,
	rawTemp: Number,
	rawHumidity: Number,
	timestamp: { type: Date, required: true },
	equipmentId: String,
	createdAt: { type: Date, default: () => new Date() }
});

temperatureReadingSchema.index({ sensorId: 1, timestamp: -1 });
temperatureReadingSchema.index({ equipmentId: 1, timestamp: -1 });

applyImmutableMiddleware(temperatureReadingSchema);

export const TemperatureReading = mongoose.models.TemperatureReading
	|| mongoose.model('TemperatureReading', temperatureReadingSchema, 'temperature_readings');
