import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';

const systemDependencySchema = new Schema({
	_id: { type: String, default: () => generateId() },
	systemName: String, ownerId: String, backupOwnerId: String,
	systemType: { type: String, enum: ['application', 'service', 'database', 'infrastructure', 'process', 'integration'] },
	dependencies: [String], dependents: [String],
	changeSensitivity: { type: String, enum: ['low', 'medium', 'high'] },
	impactScope: { type: String, enum: ['local', 'team', 'organization'] },
	lastUpdated: Date
}, { timestamps: true });

export const SystemDependency = mongoose.models.SystemDependency || mongoose.model('SystemDependency', systemDependencySchema, 'system_dependencies');
