import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found in .env');
	process.exit(1);
}

// All available permissions
const ALL_PERMISSIONS = [
	'admin:full', 'admin:users',
	'user:read', 'user:write',
	'role:read', 'role:write',
	'kanban:read', 'kanban:write', 'kanban:admin',
	'spu:read', 'spu:write', 'spu:admin',
	'document:read', 'document:write', 'document:approve', 'document:train',
	'inventory:read', 'inventory:write',
	'cartridge:read', 'cartridge:write',
	'cartridgeAdmin:read', 'cartridgeAdmin:write',
	'assay:read', 'assay:write',
	'device:read', 'device:write',
	'testResult:read', 'testResult:write',
	'manufacturing:read', 'manufacturing:write', 'manufacturing:admin',
	'waxFilling:read', 'waxFilling:write',
	'reagentFilling:read', 'reagentFilling:write',
	'workInstruction:read', 'workInstruction:write', 'workInstruction:approve',
	'documentRepo:read', 'documentRepo:write',
	'productionRun:read', 'productionRun:write',
	'shipping:read', 'shipping:write',
	'customer:read', 'customer:write',
	'equipment:read', 'equipment:write'
];

async function seed() {
	console.log('Connecting to MongoDB...');
	await mongoose.connect(MONGODB_URI!);
	console.log('Connected!');

	const db = mongoose.connection.db!;

	// Create admin role
	const adminRoleId = nanoid();
	const adminRole = {
		_id: adminRoleId,
		name: 'Admin',
		description: 'Full system administrator with all permissions',
		permissions: ALL_PERMISSIONS,
		createdAt: new Date()
	};

	// Create operator role (limited permissions)
	const operatorRoleId = nanoid();
	const operatorRole = {
		_id: operatorRoleId,
		name: 'Operator',
		description: 'Manufacturing operator with read access',
		permissions: [
			'kanban:read', 'spu:read', 'manufacturing:read',
			'waxFilling:read', 'waxFilling:write',
			'reagentFilling:read', 'reagentFilling:write',
			'cartridge:read', 'inventory:read'
		],
		createdAt: new Date()
	};

	// Create viewer role
	const viewerRoleId = nanoid();
	const viewerRole = {
		_id: viewerRoleId,
		name: 'Viewer',
		description: 'Read-only access',
		permissions: [
			'kanban:read', 'spu:read', 'document:read', 'inventory:read',
			'cartridge:read', 'manufacturing:read', 'testResult:read'
		],
		createdAt: new Date()
	};

	// Upsert roles
	const rolesCollection = db.collection('roles');
	for (const role of [adminRole, operatorRole, viewerRole]) {
		const { _id, ...roleWithoutId } = role;
		await rolesCollection.updateOne(
			{ name: role.name },
			{ $set: roleWithoutId, $setOnInsert: { _id } },
			{ upsert: true }
		);
		console.log(`Role "${role.name}" created/updated`);
	}

	// Re-fetch to get actual IDs (in case upserted)
	const actualAdminRole = await rolesCollection.findOne({ name: 'Admin' });
	const actualOperatorRole = await rolesCollection.findOne({ name: 'Operator' });
	const actualViewerRole = await rolesCollection.findOne({ name: 'Viewer' });

	// Create admin user
	const usersCollection = db.collection('users');

	const adminPasswordHash = await bcrypt.hash('contracttest123', 10);
	const now = new Date();

	const adminUser = {
		_id: nanoid(),
		username: 'contracttest',
		passwordHash: adminPasswordHash,
		firstName: 'Contract',
		lastName: 'Test',
		email: 'admin@bioscale.test',
		isActive: true,
		roles: [{
			roleId: actualAdminRole!._id,
			roleName: 'Admin',
			permissions: ALL_PERMISSIONS,
			assignedAt: now,
			assignedBy: 'seed'
		}],
		roleHistory: [{
			_id: nanoid(),
			roleId: actualAdminRole!._id,
			roleName: 'Admin',
			permissions: ALL_PERMISSIONS,
			grantedAt: now,
			grantedBy: { _id: 'seed', username: 'seed' }
		}],
		trainingRecords: [],
		communicationPreferences: [],
		corrections: [],
		createdAt: now,
		updatedAt: now
	};

	// Create test operator
	const operatorPasswordHash = await bcrypt.hash('operator123', 10);
	const operatorUser = {
		_id: nanoid(),
		username: 'operator1',
		passwordHash: operatorPasswordHash,
		firstName: 'Test',
		lastName: 'Operator',
		isActive: true,
		roles: [{
			roleId: actualOperatorRole!._id,
			roleName: 'Operator',
			permissions: actualOperatorRole!.permissions,
			assignedAt: now,
			assignedBy: 'seed'
		}],
		roleHistory: [{
			_id: nanoid(),
			roleId: actualOperatorRole!._id,
			roleName: 'Operator',
			permissions: actualOperatorRole!.permissions,
			grantedAt: now,
			grantedBy: { _id: 'seed', username: 'seed' }
		}],
		trainingRecords: [],
		communicationPreferences: [],
		corrections: [],
		createdAt: now,
		updatedAt: now
	};

	// Create test viewer
	const viewerPasswordHash = await bcrypt.hash('viewer123', 10);
	const viewerUser = {
		_id: nanoid(),
		username: 'viewer1',
		passwordHash: viewerPasswordHash,
		firstName: 'Test',
		lastName: 'Viewer',
		isActive: true,
		roles: [{
			roleId: actualViewerRole!._id,
			roleName: 'Viewer',
			permissions: actualViewerRole!.permissions,
			assignedAt: now,
			assignedBy: 'seed'
		}],
		roleHistory: [{
			_id: nanoid(),
			roleId: actualViewerRole!._id,
			roleName: 'Viewer',
			permissions: actualViewerRole!.permissions,
			grantedAt: now,
			grantedBy: { _id: 'seed', username: 'seed' }
		}],
		trainingRecords: [],
		communicationPreferences: [],
		corrections: [],
		createdAt: now,
		updatedAt: now
	};

	for (const user of [adminUser, operatorUser, viewerUser]) {
		const { _id, ...userWithoutId } = user;
		await usersCollection.updateOne(
			{ username: user.username },
			{ $set: userWithoutId, $setOnInsert: { _id } },
			{ upsert: true }
		);
		console.log(`User "${user.username}" created/updated`);
	}

	console.log('\n✅ Seed complete!');
	console.log('  Admin: contracttest / contracttest123');
	console.log('  Operator: operator1 / operator123');
	console.log('  Viewer: viewer1 / viewer123');

	await mongoose.disconnect();
}

seed().catch((err) => {
	console.error('Seed failed:', err);
	process.exit(1);
});
