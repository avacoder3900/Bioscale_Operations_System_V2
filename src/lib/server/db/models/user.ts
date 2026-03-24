import mongoose, { Schema } from 'mongoose';
import { generateId } from '../utils.js';
import { applySacredMiddleware } from '../middleware/sacred.js';

const correctionSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	fieldPath: String,
	previousValue: Schema.Types.Mixed,
	correctedValue: Schema.Types.Mixed,
	reason: String,
	correctedBy: {
		_id: String,
		username: String
	},
	correctedAt: Date,
	approvedBy: {
		_id: String,
		username: String
	},
	approvedAt: Date
}, { _id: false });

const userSchema = new Schema({
	_id: { type: String, default: () => generateId() },
	username: { type: String, required: true },
	passwordHash: { type: String, required: true },
	firstName: String,
	lastName: String,
	email: String,
	phone: String,
	isActive: { type: Boolean, default: true },
	lastLoginAt: Date,
	invitedBy: String,
	age: Number,

	roles: [{
		_id: false,
		roleId: String,
		roleName: String,
		assignedAt: Date,
		assignedBy: String,
		permissions: [String]
	}],

	roleHistory: [{
		_id: { type: String, default: () => generateId() },
		roleId: String,
		roleName: String,
		permissions: [String],
		grantedAt: Date,
		grantedBy: {
			_id: String,
			username: String
		},
		revokedAt: Date,
		revokedBy: {
			_id: String,
			username: String
		},
		revokeReason: String
	}],

	trainingRecords: [{
		_id: { type: String, default: () => generateId() },
		documentId: String,
		documentTitle: String,
		documentRevision: String,
		trainedAt: Date,
		trainerId: {
			_id: String,
			username: String
		},
		signatureId: String,
		notes: String
	}],

	communicationPreferences: [{
		_id: false,
		channel: String,
		frequency: { type: String, enum: ['real_time', 'hourly_digest', 'daily_digest', 'urgent_only'] },
		formatPreference: { type: String, enum: ['detailed', 'summary', 'bullet_points'] },
		urgencyThreshold: String,
		domainInterests: Schema.Types.Mixed,
		quietHoursStart: String,
		quietHoursEnd: String,
		isActive: Boolean,
		isDefault: Boolean
	}],

	deactivatedAt: Date,
	deactivatedBy: {
		_id: String,
		username: String
	},
	deactivationReason: String,

	corrections: [correctionSchema]
}, { timestamps: true });

userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true, sparse: true });
userSchema.index({ isActive: 1 });
userSchema.index({ 'roleHistory.roleId': 1 });
userSchema.index({ 'trainingRecords.documentId': 1 });

// Sacred document — users use deactivation pattern, not finalizedAt
// Don't apply standard sacred middleware (no finalizedAt), but block deletes
userSchema.pre('deleteOne', function (next: (err?: Error) => void) {
	return next(new Error('User documents cannot be deleted — deactivate instead'));
});
userSchema.pre('deleteMany', function (next: (err?: Error) => void) {
	return next(new Error('User documents cannot be deleted — deactivate instead'));
});
userSchema.pre('findOneAndDelete', function (next: (err?: Error) => void) {
	return next(new Error('User documents cannot be deleted — deactivate instead'));
});

export const User = mongoose.models.User || mongoose.model('User', userSchema, 'users');
