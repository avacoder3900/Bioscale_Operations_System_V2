import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ServiceTicket, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const tickets = await ServiceTicket.find({ status: { $nin: ['closed'] } })
		.sort({ openedAt: -1 })
		.limit(50)
		.lean();

	return {
		tickets: JSON.parse(JSON.stringify((tickets as any[]).map((t: any) => ({
			id: t._id,
			spuId: t.spuId,
			spuUdi: t.spuUdi ?? '',
			spuBarcode: t.spuBarcode ?? '',
			status: t.status,
			priority: t.priority ?? 'medium',
			reason: t.reason ?? null,
			openedBy: t.openedBy?.username ?? 'Unknown',
			openedAt: t.openedAt,
			partsCount: t.partsReplaced?.length ?? 0,
			firmwareCount: t.firmwareChanges?.length ?? 0,
			otherCount: t.otherChanges?.length ?? 0
		}))))
	};
};

export const actions: Actions = {
	scan: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const barcode = form.get('barcode')?.toString().trim();
		if (!barcode) return fail(400, { error: 'Barcode is required' });

		// Find SPU by barcode or UDI
		const spu = await Spu.findOne({ $or: [{ barcode }, { udi: barcode }] }).lean() as any;
		if (!spu) return fail(400, { error: `No SPU found with barcode/UDI: ${barcode}` });

		// Check for existing open ticket on this SPU
		const existing = await ServiceTicket.findOne({
			spuId: spu._id,
			status: { $nin: ['resolved', 'closed'] }
		}).lean() as any;

		if (existing) {
			throw redirect(303, `/spu/servicing/${existing._id}`);
		}

		const oldStatus = spu.status ?? 'draft';

		// Create ticket
		const ticket = await ServiceTicket.create({
			_id: generateId(),
			spuId: spu._id,
			spuUdi: spu.udi,
			spuBarcode: spu.barcode ?? barcode,
			status: 'open',
			previousSpuStatus: oldStatus,
			openedBy: { _id: locals.user!._id, username: locals.user!.username },
			openedAt: new Date()
		});

		// Transition SPU to servicing
		const transition = {
			_id: generateId(),
			from: oldStatus,
			to: 'servicing',
			changedBy: { _id: locals.user!._id, username: locals.user!.username },
			changedAt: new Date(),
			reason: 'Service ticket opened'
		};

		await Spu.updateOne(
			{ _id: spu._id },
			{
				$set: { status: 'servicing' },
				$push: { statusTransitions: transition }
			}
		);

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spu._id,
			action: 'UPDATE',
			oldData: { status: oldStatus },
			newData: { status: 'servicing', serviceTicketId: (ticket as any)._id },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		throw redirect(303, `/spu/servicing/${(ticket as any)._id}`);
	}
};

export const config = { maxDuration: 60 };
