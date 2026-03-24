import { fail, error, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ServiceTicket, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
	if (!ticket) throw error(404, 'Service ticket not found');

	if (ticket.status === 'closed') {
		throw redirect(303, `/spu/servicing/${params.ticketId}`);
	}

	const spu = await Spu.findById(ticket.spuId).lean() as any;

	// Valid return statuses — previous status + common operational statuses
	const returnStatuses = [
		ticket.previousSpuStatus,
		'validated',
		'assembled',
		'deployed',
		'released-rnd',
		'released-manufacturing',
		'released-field',
		'retired'
	].filter((v, i, a) => v && a.indexOf(v) === i); // deduplicate

	return {
		ticket: JSON.parse(JSON.stringify({
			id: ticket._id,
			spuUdi: ticket.spuUdi ?? '',
			spuId: ticket.spuId,
			status: ticket.status,
			previousSpuStatus: ticket.previousSpuStatus ?? 'draft',
			reason: ticket.reason ?? '',
			openedBy: ticket.openedBy?.username ?? 'Unknown',
			openedAt: ticket.openedAt,
			partsReplaced: (ticket.partsReplaced ?? []).map((p: any) => ({
				partNumber: p.partNumber,
				partName: p.partName,
				oldLotNumber: p.oldLotNumber,
				newLotNumber: p.newLotNumber,
				reason: p.reason
			})),
			firmwareChanges: (ticket.firmwareChanges ?? []).map((f: any) => ({
				deviceType: f.deviceType,
				previousVersion: f.previousVersion,
				newVersion: f.newVersion,
				reason: f.reason
			})),
			otherChanges: (ticket.otherChanges ?? []).map((o: any) => ({
				category: o.category,
				description: o.description
			})),
			notes: (ticket.notes ?? []).map((n: any) => ({
				text: n.text,
				addedBy: n.addedBy?.username ?? ''
			}))
		})),
		spuStatus: spu?.status ?? 'servicing',
		returnStatuses
	};
};

export const actions: Actions = {
	resolve: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const summary = form.get('summary')?.toString().trim();
		const returnStatus = form.get('returnStatus')?.toString();

		if (!summary) return fail(400, { error: 'Resolution summary is required' });
		if (!returnStatus) return fail(400, { error: 'Return status is required' });

		const ticket = await ServiceTicket.findById(params.ticketId).lean() as any;
		if (!ticket) return fail(404, { error: 'Ticket not found' });
		if (ticket.status === 'closed') return fail(400, { error: 'Ticket is already closed' });

		const operator = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();

		// Close the ticket
		await ServiceTicket.updateOne(
			{ _id: params.ticketId },
			{
				$set: {
					status: 'closed',
					resolvedAt: now,
					closedAt: now,
					resolution: {
						summary,
						returnStatus,
						resolvedBy: operator,
						resolvedAt: now
					}
				}
			}
		);

		// Transition SPU back from servicing
		const transition = {
			_id: generateId(),
			from: 'servicing',
			to: returnStatus,
			changedBy: operator,
			changedAt: now,
			reason: `Service ticket resolved: ${summary}`
		};

		await Spu.updateOne(
			{ _id: ticket.spuId },
			{
				$set: { status: returnStatus },
				$push: { statusTransitions: transition }
			}
		);

		// Audit logs
		await AuditLog.create({
			_id: generateId(),
			tableName: 'service_tickets',
			recordId: params.ticketId,
			action: 'UPDATE',
			oldData: { status: ticket.status },
			newData: { status: 'closed', resolution: summary, returnStatus },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: ticket.spuId,
			action: 'UPDATE',
			oldData: { status: 'servicing' },
			newData: { status: returnStatus, serviceTicketId: params.ticketId },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		throw redirect(303, '/spu/servicing');
	}
};

export const config = { maxDuration: 60 };
