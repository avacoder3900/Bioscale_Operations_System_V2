/**
 * Seed RobotArm and RobotArmServo documents from the known SO-ARM101 hardware.
 *
 * Run with: npx tsx scripts/seed-robot-arm.ts
 *
 * Idempotent: upserts by serialNumber (arms) and (armId, motorId) (servos).
 * Re-running won't duplicate documents.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found in .env');
	process.exit(1);
}

const JOINT_NAMES = [
	'shoulder_pan',
	'shoulder_lift',
	'elbow_flex',
	'wrist_flex',
	'wrist_roll',
	'gripper'
] as const;

const ARMS = [
	{
		role: 'leader' as const,
		serialNumber: '5C4C126959',
		comPort: 'COM10',
		modelName: 'so-arm-101',
		voltage: 12,
		controllerChip: 'CH343',
		firmwareVersion: '3.9'
	},
	{
		role: 'follower' as const,
		serialNumber: '5C4C128050',
		comPort: 'COM11',
		modelName: 'so-arm-101',
		voltage: 12,
		controllerChip: 'CH343',
		firmwareVersion: '3.9'
	}
];

async function main() {
	await mongoose.connect(MONGODB_URI!);
	console.log('Connected to MongoDB');

	const { RobotArm, RobotArmServo } = await import(
		'../src/lib/server/db/models/index.js'
	);

	for (const armData of ARMS) {
		const arm = await RobotArm.findOneAndUpdate(
			{ serialNumber: armData.serialNumber },
			{ $set: armData, $setOnInsert: { isActive: true } },
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);
		console.log(`Arm ${arm.role} -> ${arm._id} (${armData.serialNumber})`);

		for (let motorId = 1; motorId <= 6; motorId++) {
			const jointName = JOINT_NAMES[motorId - 1];
			await RobotArmServo.findOneAndUpdate(
				{ armId: arm._id, motorId },
				{
					$set: { jointName, model: 'STS3215', voltageRated: armData.voltage },
					$setOnInsert: { armId: arm._id, motorId }
				},
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			);
		}
		console.log(`  + 6 servos seeded`);
	}

	const totalArms = await RobotArm.countDocuments();
	const totalServos = await RobotArmServo.countDocuments();
	console.log(`\nTotal: ${totalArms} arms, ${totalServos} servos`);

	await mongoose.disconnect();
	console.log('Done.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
