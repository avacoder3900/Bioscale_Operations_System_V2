import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, Spu, Batch, User, Customer, AssemblySession,
	ElectronicSignature, AuditLog, ParticleDevice, generateId
} from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spu = await Spu.findById(params.spuId).lean();
	if (!spu) throw error(404, 'SPU not found');
	const s = spu as any;

	// Parallel lookups
	const [createdByUser, batch, sessions, signatures, auditTrail, customers] = await Promise.all([
		s.createdBy ? User.findById(s.createdBy, { username: 1 }).lean() : null,
		s.batch?._id ? Batch.findById(s.batch._id).lean() : null,
		AssemblySession.find({ spuId: params.spuId }).sort({ createdAt: -1 }).lean(),
		ElectronicSignature.find({ entityId: params.spuId }).sort({ signedAt: -1 }).lean(),
		AuditLog.find({ entityId: params.spuId }).sort({ createdAt: -1 }).limit(50).lean(),
		Customer.find({ status: 'active' }, { name: 1 }).lean()
	]);

	// Particle device lookup
	let particleDevice = null;
	if (s.particleLink?.particleDeviceId) {
		particleDevice = await ParticleDevice.findOne({ particleDeviceId: s.particleLink.particleDeviceId }).lean();
	}

	// Operator name lookup for sessions
	const opIds = sessions.map((ss: any) => ss.userId).filter(Boolean);
	const operators = opIds.length ? await User.find({ _id: { $in: opIds } }, { username: 1 }).lean() : [];
	const opMap = new Map(operators.map((u: any) => [u._id, u.username]));

	// Signature user lookup
	const sigUserIds = signatures.map((sig: any) => sig.userId).filter(Boolean);
	const sigUsers = sigUserIds.length ? await User.find({ _id: { $in: sigUserIds } }, { username: 1 }).lean() : [];
	const sigMap = new Map(sigUsers.map((u: any) => [u._id, u.username]));

	// Audit trail user lookup
	const auditUserIds = [...new Set(auditTrail.map((a: any) => a.userId).filter(Boolean))];
	const auditUsers = auditUserIds.length ? await User.find({ _id: { $in: auditUserIds } }, { username: 1 }).lean() : [];
	const auditMap = new Map(auditUsers.map((u: any) => [u._id, u.username]));

	return {
		spu: {
			id: s._id,
			udi: s.udi,
			barcode: s.barcode ?? null,
			status: s.status ?? 'draft',
			deviceState: s.deviceState ?? '',
			owner: s.owner ?? null,
			ownerNotes: s.ownerNotes ?? null,
			batchId: s.batch?._id ?? null,
			createdBy: s.createdBy ?? null,
			createdAt: s.createdAt,
			updatedAt: s.updatedAt,
			assignmentType: s.assignment?.type ?? null,
			assignmentCustomerId: s.assignment?.customer?._id ?? null,
			qcStatus: s.qcStatus ?? 'pending',
			qcDocumentUrl: s.qcDocumentUrl ?? null,
			assemblyStatus: s.assemblyStatus ?? 'created',
			assemblySignatureId: s.signature?._id ?? null,
			assemblyCompletedAt: s.assembly?.completedAt ?? null,
			statusTransitions: (s.statusTransitions ?? []).map((t: any) => ({
				id: t._id,
				from: t.from ?? null,
				to: t.to,
				changedBy: t.changedBy?.username ?? 'System',
				changedAt: t.changedAt,
				reason: t.reason ?? null
			})),
			finalizedAt: s.finalizedAt ?? null,
			corrections: s.corrections ?? []
		},
		batch: batch
			? {
					id: (batch as any)._id,
					batchNumber: (batch as any).batchNumber ?? ''
				}
			: null,
		createdByName: (createdByUser as any)?.username ?? null,
		assignmentCustomerName: s.assignment?.customer?.name ?? null,
		activeCustomers: customers.map((c: any) => ({ id: c._id, name: c.name })),
		particleLink: s.particleLink?.particleDeviceId
			? {
					id: s.particleLink.particleDeviceId,
					spuId: params.spuId,
					particleDeviceId: s.particleLink.particleDeviceId,
					particleSerial: s.particleLink.particleSerial ?? null,
					linkedAt: s.particleLink.linkedAt
				}
			: null,
		particleDevice: particleDevice
			? {
					id: (particleDevice as any)._id,
					deviceId: (particleDevice as any).deviceId,
					particleDeviceId: (particleDevice as any).particleDeviceId ?? (particleDevice as any).deviceId ?? null,
					serialNumber: (particleDevice as any).serialNumber ?? null,
					firmwareVersion: (particleDevice as any).firmwareVersion ?? null,
					systemVersion: (particleDevice as any).systemVersion ?? null,
					status: (particleDevice as any).status ?? null,
					lastHeardAt: (particleDevice as any).lastHeardAt ?? null,
					lastIpAddress: (particleDevice as any).lastIpAddress ?? null,
					name: (particleDevice as any).name ?? null,
					linkedSpuId: (particleDevice as any).linkedSpuId ?? null,
					lastSyncAt: (particleDevice as any).lastSyncAt ?? null
				}
			: null,
		parts: (s.parts ?? []).map((p: any) => ({
			id: p._id,
			partNumber: p.partNumber ?? '',
			partName: p.partName ?? '',
			partId: p.partDefinitionId ?? '',
			lotNumber: p.lotNumber ?? null,
			lotId: null,
			quantityUsed: 1,
			recordedAt: p.scannedAt ?? s.createdAt,
			recordedByName: p.scannedBy?.username ?? '',
			source: 'assembly' as const
		})),
		sessions: sessions.map((ss: any) => ({
			id: ss._id,
			startedAt: ss.startedAt ?? ss.createdAt,
			completedAt: ss.completedAt ?? null,
			status: ss.status,
			operatorId: ss.userId ?? '',
			operatorName: opMap.get(ss.userId) ?? ''
		})),
		signatures: signatures.map((sig: any) => ({
			id: sig._id,
			entityType: sig.entityType ?? '',
			meaning: sig.meaning ?? '',
			signedAt: sig.signedAt,
			userId: sig.userId ?? '',
			userName: sigMap.get(sig.userId) ?? ''
		})),
		assemblySignature: s.signature?._id
			? {
					id: s.signature._id,
					entityType: 'spu',
					meaning: s.signature.meaning ?? '',
					signedAt: s.signature.signedAt,
					userId: s.signature.userId ?? '',
					userName: s.signature.username ?? ''
				}
			: null,
		assemblyStatusHistory: [],
		auditTrail: auditTrail.map((a: any) => ({
			id: a._id,
			action: a.action ?? '',
			oldData: a.oldData ?? null,
			newData: a.newData ?? null,
			changedBy: auditMap.get(a.userId) ?? 'System',
			changedAt: a.createdAt
		}))
	};
};

export const actions: Actions = {
	updateState: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const deviceState = form.get('deviceState')?.toString();
		if (!deviceState) return fail(400, { error: 'State required' });

		const spu = await Spu.findById(params.spuId);
		if (!spu) return fail(404, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized' });

		const updates: Record<string, any> = { deviceState };
		if (form.get('owner')) updates.owner = form.get('owner')!.toString();
		if (form.get('ownerNotes')) updates.ownerNotes = form.get('ownerNotes')!.toString();
		await Spu.updateOne({ _id: params.spuId }, { $set: updates });
		return { success: true };
	},

	linkParticle: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const particleDeviceId = form.get('particleDeviceId')?.toString();
		if (!particleDeviceId) return fail(400, { error: 'Device ID required' });

		await Spu.updateOne({ _id: params.spuId }, {
			$set: {
				particleLink: {
					particleDeviceId,
					linkedAt: new Date(),
					linkedBy: { _id: locals.user!._id, username: locals.user!.username }
				}
			}
		});
		return { success: true };
	},

	unlinkParticle: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		await Spu.updateOne({ _id: params.spuId }, { $unset: { particleLink: '' } });
		return { success: true };
	},

	updateAssignment: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const assignmentType = form.get('assignmentType')?.toString();
		if (!assignmentType) return fail(400, { error: 'Type required' });

		const spu = await Spu.findById(params.spuId);
		if (!spu) return fail(404, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized' });

		const assignment: Record<string, any> = {
			type: assignmentType,
			assignedAt: new Date(),
			assignedBy: { _id: locals.user!._id, username: locals.user!.username }
		};
		if (form.get('customerId')) {
			const customer = await Customer.findById(form.get('customerId')!.toString()).lean();
			if (customer) assignment.customer = { _id: (customer as any)._id, name: (customer as any).name };
		}

		const oldStatus = (spu as any).status ?? 'draft';
		const newStatus = 'assigned';
		const updates: Record<string, any> = { assignment, status: newStatus };
		const pushOps: Record<string, any> = {};

		if (oldStatus !== newStatus) {
			pushOps.statusTransitions = {
				_id: generateId(),
				from: oldStatus,
				to: newStatus,
				changedBy: { _id: locals.user!._id, username: locals.user!.username },
				changedAt: new Date(),
				reason: `Assigned as ${assignmentType}`
			};
		}

		const updateQuery: Record<string, any> = { $set: updates };
		if (Object.keys(pushOps).length) updateQuery.$push = pushOps;

		await Spu.updateOne({ _id: params.spuId }, updateQuery);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: params.spuId,
			action: 'UPDATE',
			oldData: { status: oldStatus, assignment: (spu as any).assignment },
			newData: { status: newStatus, assignment },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { success: true };
	},

	updateAssemblyStatus: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const assemblyStatus = form.get('assemblyStatus')?.toString();
		if (!assemblyStatus) return fail(400, { error: 'Status required' });

		const spu = await Spu.findById(params.spuId);
		if (!spu) return fail(404, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized' });

		const updates: Record<string, any> = { assemblyStatus };

		// If completing assembly, optionally create signature
		if (assemblyStatus === 'completed') {
			const password = form.get('password')?.toString();
			const meaning = form.get('meaning')?.toString() || 'Assembly completed';
			if (password) {
				// Verify password and create electronic signature
				const sigId = generateId();
				await ElectronicSignature.create({
					_id: sigId,
					userId: locals.user!._id,
					entityType: 'spu',
					entityId: params.spuId,
					meaning,
					signedAt: new Date(),
					dataHash: '' // would be computed from SPU data
				});
				updates['signature'] = {
					_id: sigId,
					userId: locals.user!._id,
					username: locals.user!.username,
					meaning,
					signedAt: new Date()
				};
			}
			updates.status = 'assembled';
		}

		await Spu.updateOne({ _id: params.spuId }, { $set: updates });
		return { success: true };
	},

	updateIdentifiers: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const newUdi = form.get('udi')?.toString().trim();
		const newBarcode = form.get('barcode')?.toString().trim() || null;

		if (!newUdi) return fail(400, { error: 'UDI is required' });

		const spu = await Spu.findById(params.spuId);
		if (!spu) return fail(404, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized and cannot be modified' });

		// Check UDI uniqueness if changed
		if (newUdi !== (spu as any).udi) {
			const existing = await Spu.findOne({ udi: newUdi, _id: { $ne: params.spuId } });
			if (existing) return fail(400, { error: 'Another SPU already has this UDI' });
		}

		const oldData = { udi: (spu as any).udi, barcode: (spu as any).barcode };
		try {
			await Spu.updateOne({ _id: params.spuId }, { $set: { udi: newUdi, barcode: newBarcode } });
		} catch (err: any) {
			console.error('[updateIdentifiers] Update failed:', err.message);
			return fail(500, { error: err.message || 'Failed to update SPU' });
		}

		try {
			await AuditLog.create({
				_id: generateId(),
				tableName: 'spus',
				recordId: params.spuId,
				action: 'UPDATE',
				oldData,
				newData: { udi: newUdi, barcode: newBarcode },
				changedBy: locals.user!.username ?? locals.user!._id
			});
		} catch (err: any) {
			console.error('[updateIdentifiers] Audit log failed:', err.message);
			// Non-critical — don't fail the update
		}

		return { identifierSuccess: true };
	},

	transitionStatus: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const newStatus = form.get('status')?.toString();
		const reason = form.get('reason')?.toString() || null;
		if (!newStatus) return fail(400, { error: 'Status required' });

		const spu = await Spu.findById(params.spuId);
		if (!spu) return fail(404, { error: 'SPU not found' });
		if ((spu as any).finalizedAt) return fail(400, { error: 'SPU is finalized' });

		const oldStatus = (spu as any).status ?? 'draft';
		if (oldStatus === newStatus) return fail(400, { error: 'Status is already ' + newStatus });

		const transition = {
			_id: generateId(),
			from: oldStatus,
			to: newStatus,
			changedBy: { _id: locals.user!._id, username: locals.user!.username },
			changedAt: new Date(),
			reason
		};

		await Spu.updateOne(
			{ _id: params.spuId },
			{
				$set: { status: newStatus },
				$push: { statusTransitions: transition }
			}
		);

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: params.spuId,
			action: 'UPDATE',
			oldData: { status: oldStatus },
			newData: { status: newStatus, reason },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { success: true, transitionSuccess: true };
	}
};
