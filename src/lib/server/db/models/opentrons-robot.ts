import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const opentronsRobotSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	name: String, ip: String, port: Number, robotSide: String,
	legacyRobotId: String, isActive: { type: Boolean, default: true },
	firmwareVersion: String, apiVersion: String, robotModel: String, robotSerial: String,
	lastHealthAt: Date, lastHealthOk: Boolean, source: String,
	protocols: [{
		_id: { type: String, default: () => generateId() },
		opentronsProtocolId: String, protocolName: String, protocolType: String,
		fileHash: String, parametersSchema: Schema.Types.Mixed,
		analysisStatus: String, analysisData: Schema.Types.Mixed,
		labwareDefinitions: Schema.Types.Mixed, pipettesRequired: Schema.Types.Mixed,
		uploadedBy: String, createdAt: Date, updatedAt: Date
	}],
	recentHealthSnapshots: [{
		firmwareVersion: String, apiVersion: String, systemVersion: String,
		leftPipette: Schema.Types.Mixed, rightPipette: Schema.Types.Mixed,
		modules: Schema.Types.Mixed, isHealthy: Boolean, responseTimeMs: Number,
		errorMessage: String, createdAt: Date
	}]
}, { timestamps: true });

export const OpentronsRobot = mongoose.models.OpentronsRobot || mongoose.model('OpentronsRobot', opentronsRobotSchema, 'opentrons_robots');
