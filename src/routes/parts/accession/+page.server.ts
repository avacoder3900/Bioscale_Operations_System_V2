import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, AuditLog, generateId } from '$lib/server/db';
import { generatePartBarcode } from '$lib/server/services/barcode-generator';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const allParts = await PartDefinition.find({ isActive: true })
		.select('partNumber name category bomType inventoryCount barcode createdAt updatedAt')
		.sort({ partNumber: 1 })
		.lean() as any[];

	const registered = allParts
		.filter((p: any) => p.barcode)
		.map((p: any) => ({
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			category: p.category ?? null,
			bomType: p.bomType ?? null,
			inventoryCount: p.inventoryCount ?? 0,
			barcode: p.barcode
		}));

	const unregistered = allParts
		.filter((p: any) => !p.barcode)
		.map((p: any) => ({
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			category: p.category ?? null,
			bomType: p.bomType ?? null,
			inventoryCount: p.inventoryCount ?? 0
		}));

	return {
		registered: JSON.parse(JSON.stringify(registered)),
		unregistered: JSON.parse(JSON.stringify(unregistered)),
		counts: {
			total: allParts.length,
			registered: registered.length,
			unregistered: unregistered.length
		}
	};
};

export const actions: Actions = {
	assignBarcode: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const form = await request.formData();
		const partDefinitionId = form.get('partDefinitionId')?.toString();
		if (!partDefinitionId) return fail(400, { error: 'Part ID required' });

		const part = await PartDefinition.findById(partDefinitionId) as any;
		if (!part) return fail(404, { error: 'Part not found' });
		if (part.barcode) return fail(400, { error: 'Part already has a barcode' });

		const barcode = await generatePartBarcode();
		part.barcode = barcode;
		await part.save();

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: partDefinitionId,
			action: 'UPDATE',
			oldData: { barcode: null },
			newData: { barcode },
			changedAt: new Date(),
			changedBy: locals.user!.username,
			changedFields: ['barcode'],
			reason: 'Barcode assigned via Part Accession'
		});

		return { success: true, barcode, partNumber: part.partNumber };
	},

	assignAll: async ({ locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const unregistered = await PartDefinition.find({
			isActive: true,
			$or: [{ barcode: null }, { barcode: '' }, { barcode: { $exists: false } }]
		}).sort({ partNumber: 1 }).lean() as any[];

		if (unregistered.length === 0) {
			return { assignAllSuccess: true, count: 0, assignments: [] };
		}

		const assignments: { partNumber: string; barcode: string }[] = [];
		const failures: { partNumber: string; error: string }[] = [];

		for (const part of unregistered) {
			try {
				const barcode = await generatePartBarcode();
				await PartDefinition.updateOne({ _id: part._id }, { $set: { barcode } });

				await AuditLog.create({
					_id: generateId(),
					tableName: 'part_definitions',
					recordId: part._id,
					action: 'UPDATE',
					oldData: { barcode: null },
					newData: { barcode },
					changedAt: new Date(),
					changedBy: locals.user!.username,
					changedFields: ['barcode'],
					reason: 'Bulk barcode assignment via Part Accession'
				});

				assignments.push({ partNumber: part.partNumber, barcode });
			} catch (err) {
				failures.push({
					partNumber: part.partNumber,
					error: err instanceof Error ? err.message : 'Unknown error'
				});
			}
		}

		return {
			assignAllSuccess: true,
			count: assignments.length,
			assignments,
			failures: failures.length > 0 ? failures : undefined
		};
	},

	exportLabels: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:read');
		await connectDB();

		const form = await request.formData();
		const partIds = form.get('partIds')?.toString();

		let filter: Record<string, any> = { isActive: true, barcode: { $exists: true, $nin: [null, ''] } };
		if (partIds) {
			const ids = partIds.split(',').map((s: string) => s.trim()).filter(Boolean);
			if (ids.length > 0) filter._id = { $in: ids };
		}

		const parts = await PartDefinition.find(filter)
			.select('partNumber name barcode category bomType')
			.sort({ partNumber: 1 })
			.lean() as any[];

		// Generate CSV
		const header = 'Part Number,Part Name,Barcode,Category,BOM Type';
		const rows = parts.map((p: any) =>
			`"${p.partNumber ?? ''}","${(p.name ?? '').replace(/"/g, '""')}","${p.barcode ?? ''}","${p.category ?? ''}","${p.bomType ?? ''}"`
		);
		const csv = [header, ...rows].join('\n');

		return {
			exportSuccess: true,
			csv,
			count: parts.length
		};
	}
};
