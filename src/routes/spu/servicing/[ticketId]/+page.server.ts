import { fail, error, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ServiceTicket, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
	if (!ticket) throw error(404, 'Service ticket not found');

	const spu = await Spu.findById(ticket.spuId).lean() as any;
	if (!spu) throw error(404, 'Associated SPU not found');

	return {
		ticket: JSON.parse(JSON.stringify({
			id: ticket._id,
			spuId: ticket.spuId,
			spuUdi: ticket.spuUdi ?? '',
			spuBarcode: ticket.spuBarcode ?? '',
			status: ticket.status,
			priority: ticket.priority ?? 'medium',
			reason: ticket.reason ?? '',
			previousSpuStatus: ticket.previousSpuStatus ?? 'draft',
			openedBy: ticket.openedBy?.username ?? 'Unknown',
			assignedTo: ticket.assignedTo?.username ?? null,
			openedAt: ticket.openedAt,
			partsReplaced: (ticket.partsReplaced ?? []).map((p: any) => ({
				id: p._id,
				partNumber: p.partNumber ?? '',
				partName: p.partName ?? '',
				oldLotNumber: p.oldLotNumber ?? '',
				newLotNumber: p.newLotNumber ?? '',
				newSerialNumber: p.newSerialNumber ?? '',
				reason: p.reason ?? '',
				replacedBy: p.replacedBy?.username ?? '',
				replacedAt: p.replacedAt
			})),
			firmwareChanges: (ticket.firmwareChanges ?? []).map((f: any) => ({
				id: f._id,
				deviceType: f.deviceType ?? '',
				previousVersion: f.previousVersion ?? '',
				newVersion: f.newVersion ?? '',
				reason: f.reason ?? '',
				performedBy: f.performedBy?.username ?? '',
				performedAt: f.performedAt
			})),
			otherChanges: (ticket.otherChanges ?? []).map((o: any) => ({
				id: o._id,
				category: o.category ?? '',
				description: o.description ?? '',
				performedBy: o.performedBy?.username ?? '',
				performedAt: o.performedAt
			})),
			notes: (ticket.notes ?? []).map((n: any) => ({
				id: n._id,
				text: n.text ?? '',
				addedBy: n.addedBy?.username ?? '',
				addedAt: n.addedAt
			}))
		})),
		spu: JSON.parse(JSON.stringify({
			id: spu._id,
			udi: spu.udi,
			barcode: spu.barcode ?? null,
			status: spu.status ?? 'draft',
			parts: (spu.parts ?? []).filter((p: any) => !p.isReplaced).map((p: any) => ({
				id: p._id,
				partNumber: p.partNumber ?? '',
				partName: p.partName ?? '',
				lotNumber: p.lotNumber ?? '',
				serialNumber: p.serialNumber ?? ''
			})),
			particleLink: spu.particleLink?.particleDeviceId ? {
				particleDeviceId: spu.particleLink.particleDeviceId,
				particleSerial: spu.particleLink.particleSerial ?? null
			} : null
		}))
	};
};

export const actions: Actions = {
	replacePart: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuPartId = form.get('spuPartId')?.toString();
		const newLotNumber = form.get('newLotNumber')?.toString().trim();
		const newSerialNumber = form.get('newSerialNumber')?.toString().trim() || null;
		const reason = form.get('reason')?.toString().trim();

		if (!spuPartId || !newLotNumber || !reason) {
			return fail(400, { error: 'Part, new lot number, and reason are required' });
		}

		const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
		if (!ticket) return fail(404, { error: 'Ticket not found' });
		if (ticket.status === 'closed' || ticket.status === 'resolved') {
			return fail(400, { error: 'Cannot modify a resolved ticket' });
		}

		const spu = await Spu.findById(ticket.spuId).lean() as any;
		if (!spu) return fail(404, { error: 'SPU not found' });

		const oldPart = (spu.parts ?? []).find((p: any) => p._id === spuPartId);
		if (!oldPart) return fail(400, { error: 'Part not found on SPU' });

		const operator = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();

		// Push replacement record to ticket
		await ServiceTicket.updateOne(
			{ _id: params.ticketId },
			{
				$push: {
					partsReplaced: {
						_id: generateId(),
						spuPartId,
						partNumber: oldPart.partNumber,
						partName: oldPart.partName,
						oldLotNumber: oldPart.lotNumber,
						newLotNumber,
						newSerialNumber,
						reason,
						replacedBy: operator,
						replacedAt: now
					}
				}
			}
		);

		// Mark old part as replaced on SPU
		await Spu.updateOne(
			{ _id: ticket.spuId, 'parts._id': spuPartId },
			{
				$set: {
					'parts.$.isReplaced': true,
					'parts.$.replacedBy': newLotNumber,
					'parts.$.replaceReason': reason
				}
			}
		);

		// Add new part to SPU
		await Spu.updateOne(
			{ _id: ticket.spuId },
			{
				$push: {
					parts: {
						_id: generateId(),
						partDefinitionId: oldPart.partDefinitionId,
						partNumber: oldPart.partNumber,
						partName: oldPart.partName,
						lotNumber: newLotNumber,
						serialNumber: newSerialNumber,
						scannedAt: now,
						scannedBy: operator,
						isReplaced: false
					}
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'service_tickets',
			recordId: params.ticketId,
			action: 'UPDATE',
			oldData: { partId: spuPartId, lotNumber: oldPart.lotNumber },
			newData: { newLotNumber, newSerialNumber, reason },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { success: true };
	},

	recordFirmwareChange: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const deviceType = form.get('deviceType')?.toString().trim();
		const previousVersion = form.get('previousVersion')?.toString().trim();
		const newVersion = form.get('newVersion')?.toString().trim();
		const reason = form.get('reason')?.toString().trim();

		if (!deviceType || !newVersion || !reason) {
			return fail(400, { error: 'Device type, new version, and reason are required' });
		}

		const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
		if (!ticket) return fail(404, { error: 'Ticket not found' });
		if (ticket.status === 'closed' || ticket.status === 'resolved') {
			return fail(400, { error: 'Cannot modify a resolved ticket' });
		}

		const operator = { _id: locals.user!._id, username: locals.user!.username };

		await ServiceTicket.updateOne(
			{ _id: params.ticketId },
			{
				$push: {
					firmwareChanges: {
						_id: generateId(),
						deviceType,
						previousVersion: previousVersion || null,
						newVersion,
						reason,
						performedBy: operator,
						performedAt: new Date()
					}
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'service_tickets',
			recordId: params.ticketId,
			action: 'UPDATE',
			oldData: { deviceType, previousVersion },
			newData: { deviceType, newVersion, reason },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { success: true };
	},

	recordOtherChange: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const category = form.get('category')?.toString().trim();
		const description = form.get('description')?.toString().trim();

		if (!category || !description) {
			return fail(400, { error: 'Category and description are required' });
		}

		const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
		if (!ticket) return fail(404, { error: 'Ticket not found' });
		if (ticket.status === 'closed' || ticket.status === 'resolved') {
			return fail(400, { error: 'Cannot modify a resolved ticket' });
		}

		const operator = { _id: locals.user!._id, username: locals.user!.username };

		await ServiceTicket.updateOne(
			{ _id: params.ticketId },
			{
				$push: {
					otherChanges: {
						_id: generateId(),
						category,
						description,
						performedBy: operator,
						performedAt: new Date()
					}
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'service_tickets',
			recordId: params.ticketId,
			action: 'UPDATE',
			oldData: null,
			newData: { category, description },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { success: true };
	},

	addNote: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const text = form.get('text')?.toString().trim();
		if (!text) return fail(400, { error: 'Note text is required' });

		const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
		if (!ticket) return fail(404, { error: 'Ticket not found' });

		await ServiceTicket.updateOne(
			{ _id: params.ticketId },
			{
				$push: {
					notes: {
						_id: generateId(),
						text,
						addedBy: { _id: locals.user!._id, username: locals.user!.username },
						addedAt: new Date()
					}
				}
			}
		);

		return { success: true };
	},

	updateStatus: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const newStatus = form.get('status')?.toString();
		if (!newStatus) return fail(400, { error: 'Status is required' });

		const valid = ['open', 'in_progress', 'pending_parts'];
		if (!valid.includes(newStatus)) return fail(400, { error: 'Invalid status' });

		const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
		if (!ticket) return fail(404, { error: 'Ticket not found' });
		if (ticket.status === 'closed' || ticket.status === 'resolved') {
			return fail(400, { error: 'Cannot change status of a resolved ticket' });
		}

		await ServiceTicket.updateOne({ _id: params.ticketId }, { $set: { status: newStatus } });

		return { success: true };
	},

	updateReason: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const reason = form.get('reason')?.toString().trim();
		if (!reason) return fail(400, { error: 'Reason is required' });

		const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
		if (!ticket) return fail(404, { error: 'Ticket not found' });
		if (ticket.status === 'closed' || ticket.status === 'resolved') {
			return fail(400, { error: 'Cannot modify a resolved ticket' });
		}

		await ServiceTicket.updateOne({ _id: params.ticketId }, { $set: { reason } });

		return { success: true };
	}
};
