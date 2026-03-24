import { error, redirect } from '@sveltejs/kit';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { connectDB, AssayDefinition, FirmwareCartridge, TestResult } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'assay:read');
	await connectDB();

	const assay = await AssayDefinition.findById(params.assayId).lean() as any;
	if (!assay) throw error(404, 'Assay not found');

	const [linkedCartridges, testResults] = await Promise.all([
		FirmwareCartridge.find({ assayId: params.assayId }, {
			_id: 1, cartridgeUuid: 1, status: 1, lotNumber: 1, serialNumber: 1, createdAt: 1
		}).sort({ createdAt: -1 }).limit(100).lean(),
		TestResult.find({ assayId: params.assayId }, {
			_id: 1, cartridgeUuid: 1, deviceId: 1, status: 1, duration: 1,
			numberOfReadings: 1, createdAt: 1
		}).sort({ createdAt: -1 }).limit(100).lean()
	]);

	// Convert bcode buffer to hex string if present
	let bcodeString: string | null = null;
	if (assay.bcode) {
		try {
			const buf = Buffer.isBuffer(assay.bcode) ? assay.bcode : Buffer.from(assay.bcode);
			bcodeString = buf.toString('hex');
		} catch {
			bcodeString = null;
		}
	}

	// Protocol instructions from assay metadata
	const instructions = (assay.metadata?.instructions ?? []).map((instr: any) => ({
		type: instr.type ?? 'unknown',
		params: instr.params ?? []
	}));

	const canWrite = hasPermission(locals.user, 'assay:write') || hasPermission(locals.user, 'admin:full');
	const canDelete = hasPermission(locals.user, 'admin:full');

	return {
		assay: {
			id: assay._id,
			assayId: assay._id,
			name: assay.name,
			skuCode: assay.skuCode ?? null,
			version: assay.versionHistory?.length ?? 0,
			status: assay.lockedAt ? 'locked' : (assay.isActive ? 'active' : 'inactive'),
			isActive: assay.isActive ?? true,
			description: assay.description ?? null,
			duration: assay.duration ?? null,
			shelfLifeDays: assay.shelfLifeDays ?? null,
			bcode: assay.bcode ?? null,
			bcodeLength: assay.bcodeLength ?? null,
			checksum: assay.checksum ?? null,
			bomCostOverride: assay.bomCostOverride ?? null,
			useSingleCost: assay.useSingleCost ?? false,
			lockedAt: assay.lockedAt ?? null,
			lockedBy: assay.lockedBy ?? null,
			metadata: assay.metadata ?? null,
			reagents: (assay.reagents ?? []).map((r: any) => ({
				id: r._id,
				wellPosition: r.wellPosition ?? null,
				reagentName: r.reagentName ?? null,
				unitCost: r.unitCost ?? null,
				volumeMicroliters: r.volumeMicroliters ?? null,
				unit: r.unit ?? null,
				classification: r.classification ?? null,
				hasBreakdown: r.hasBreakdown ?? false,
				sortOrder: r.sortOrder ?? null,
				isActive: r.isActive ?? true,
				subComponents: (r.subComponents ?? []).map((s: any) => ({
					id: s._id,
					name: s.name ?? null,
					unitCost: s.unitCost ?? null,
					unit: s.unit ?? null,
					volumeMicroliters: s.volumeMicroliters ?? null,
					classification: s.classification ?? null,
					sortOrder: s.sortOrder ?? null
				}))
			})),
			createdAt: assay.createdAt,
			updatedAt: assay.updatedAt
		},
		versions: (assay.versionHistory ?? []).map((v: any) => ({
			version: v.version,
			createdAt: v.changedAt ?? null,
			changes: v.changeNotes ?? null
		})),
		instructions,
		bcodeString,
		linkedCartridges: (linkedCartridges as any[]).map((c: any) => ({
			id: c._id,
			cartridgeUuid: c.cartridgeUuid ?? '',
			status: c.status ?? null,
			lotNumber: c.lotNumber ?? null,
			serialNumber: c.serialNumber ?? null,
			createdAt: c.createdAt
		})),
		testResults: (testResults as any[]).map((r: any) => ({
			id: r._id,
			cartridgeUuid: r.cartridgeUuid ?? null,
			deviceId: r.deviceId ?? null,
			status: r.status ?? null,
			duration: r.duration ?? null,
			numberOfReadings: r.numberOfReadings ?? 0,
			createdAt: r.createdAt
		})),
		canWrite,
		canDelete
	};
};

export const actions: Actions = {
	lock: async ({ params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		await AssayDefinition.findOneAndUpdate(
			{ _id: params.assayId, lockedAt: { $exists: false } },
			{
				$set: {
					lockedAt: new Date(),
					lockedBy: { _id: locals.user._id, username: locals.user.username }
				}
			}
		);
		return { success: true };
	},

	unlock: async ({ params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		await AssayDefinition.findByIdAndUpdate(params.assayId, {
			$unset: { lockedAt: 1, lockedBy: 1 }
		});
		return { success: true };
	},

	toggleActive: async ({ params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'assay:write');
		await connectDB();

		const assay = await AssayDefinition.findById(params.assayId).lean() as any;
		if (!assay) throw error(404, 'Assay not found');

		await AssayDefinition.findByIdAndUpdate(params.assayId, {
			$set: { isActive: !assay.isActive }
		});
		return { success: true };
	}
};
