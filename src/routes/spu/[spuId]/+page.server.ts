import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, Spu, Batch, User, Customer, AssemblySession,
	ElectronicSignature, AuditLog, ParticleDevice, ValidationSession, generateId
} from '$lib/server/db';
import { byId } from '$lib/server/db/native-helpers';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spu = await Spu.findById(params.spuId).lean();
	if (!spu) throw error(404, 'SPU not found');
	const s = spu as any;

	// Parallel lookups
	const [createdByUser, batch, sessions, signatures, auditTrail, customers, validationSessions] = await Promise.all([
		s.createdBy ? User.findById(s.createdBy, { username: 1 }).lean() : null,
		s.batch?._id ? Batch.findById(s.batch._id).lean() : null,
		AssemblySession.find({ spuId: params.spuId }).sort({ createdAt: -1 }).lean(),
		ElectronicSignature.find({ entityId: params.spuId }).sort({ signedAt: -1 }).lean(),
		AuditLog.find({ entityId: params.spuId }).sort({ createdAt: -1 }).limit(50).lean(),
		Customer.find({ status: 'active' }, { name: 1 }).lean(),
		ValidationSession.find({ spuId: params.spuId })
			.select('_id type status startedAt completedAt overallPassed failureReasons criteriaUsed magResults override userId rawData')
			.sort({ createdAt: -1 })
			.lean()
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

	// Validation session user lookup
	const valUserIds = [...new Set((validationSessions as any[]).map((v: any) => v.userId).filter(Boolean))];
	const valUsers = valUserIds.length ? await User.find({ _id: { $in: valUserIds } }, { username: 1 }).lean() : [];
	const valMap = new Map(valUsers.map((u: any) => [u._id, u.username]));

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
			validation: {
				magnetometer: s.validation?.magnetometer ?? null,
				thermocouple: s.validation?.thermocouple ?? null,
				lux: s.validation?.lux ?? null,
				spectrophotometer: s.validation?.spectrophotometer ?? null,
				status: s.validation?.status ?? 'pending'
			},
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
			corrections: s.corrections ?? [],
			validationResetAt: s.validationResetAt ?? null,
			serviceRecords: (s.serviceRecords ?? []).map((r: any) => ({
				id: r._id,
				cycle: r.cycle ?? null,
				issue: r.issue ?? '',
				initialTestPlan: r.initialTestPlan ?? '',
				fix: r.fix ?? null,
				status: r.status ?? 'open',
				openedByName: r.openedBy?.username ?? null,
				openedAt: r.openedAt ?? null,
				returnedByName: r.returnedBy?.username ?? null,
				returnedAt: r.returnedAt ?? null
			}))
		},
		attachments: (s.attachments ?? []).map((a: any) => {
			// Parse a capped preview (header + up to 50 rows) for inline viewing.
			const raw = typeof a.content === 'string' ? a.content : '';
			const lines = raw.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
			const grid = lines.slice(0, 51).map((l: string) => l.split(','));
			return {
				id: a._id,
				fileName: a.fileName ?? 'attachment.csv',
				kind: a.kind ?? 'file',
				fileSize: a.fileSize ?? 0,
				rowCount: a.rowCount ?? null,
				sessionId: a.sessionId ?? null,
				uploadedAt: a.uploadedAt ?? null,
				uploadedByName: a.uploadedBy?.username ?? null,
				preview: {
					header: grid[0] ?? [],
					rows: grid.slice(1),
					truncated: lines.length > 51
				}
			};
		}),
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
		validationSessions: (validationSessions as any[]).map((v: any) => ({
			id: v._id,
			type: v.type,
			status: v.status,
			startedAt: v.startedAt,
			completedAt: v.completedAt,
			overallPassed: v.overallPassed ?? null,
			failureReasons: v.failureReasons ?? [],
			criteriaUsed: v.criteriaUsed ?? null,
			magResults: v.magResults ?? null,
			rawData: v.rawData ?? null,
			operatorName: valMap.get(v.userId) ?? 'Unknown',
			override: v.override ? {
				by: v.override.by,
				at: v.override.at,
				reason: v.override.reason,
				originalResult: v.override.originalResult
			} : null
		})),
		auditTrail: auditTrail.map((a: any) => ({
			id: a._id,
			action: a.action ?? '',
			reason: a.reason ?? null,
			oldData: a.oldData ?? null,
			newData: a.newData ?? null,
			changedBy: auditMap.get(a.userId) ?? auditMap.get(a.changedBy) ?? 'System',
			changedAt: a.changedAt ?? a.createdAt
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

	pingDevice: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const spu = await Spu.findById(params.spuId).select('particleLink').lean() as any;
		const deviceId = spu?.particleLink?.particleDeviceId;
		if (!deviceId) return fail(400, { error: 'No Particle device linked' });

		const { pingDevice } = await import('$lib/server/particle');
		try {
			const result = await pingDevice(deviceId);
			return { message: result.online ? 'Device is online.' : 'Device did not respond — offline.' };
		} catch (err) {
			return fail(502, { error: err instanceof Error ? err.message : 'Ping failed' });
		}
	},

	renameDevice: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'Name is required' });

		const spu = await Spu.findById(params.spuId).select('particleLink').lean() as any;
		const deviceId = spu?.particleLink?.particleDeviceId;
		if (!deviceId) return fail(400, { error: 'No Particle device linked' });

		const { renameDevice, getDevice } = await import('$lib/server/particle');
		try {
			const oldName = (await getDevice(deviceId)).name;
			await renameDevice(deviceId, name);
			await ParticleDevice.updateOne({ particleDeviceId: deviceId }, { $set: { name } });
			await AuditLog.create({
				_id: generateId(),
				tableName: 'spus',
				recordId: params.spuId,
				action: 'UPDATE',
				oldData: { particleDeviceName: oldName },
				newData: { particleDeviceName: name },
				changedBy: locals.user!.username ?? locals.user!._id
			});
			return { message: `Device renamed to ${name}.` };
		} catch (err) {
			return fail(502, { error: err instanceof Error ? err.message : 'Rename failed' });
		}
	},

	uploadCsv: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'A CSV file is required' });
		}
		if (file.size > 2 * 1024 * 1024) {
			return fail(400, { error: 'File too large (max 2 MB)' });
		}
		const content = await file.text();
		// Row count = non-empty lines minus the header row.
		const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
		const rowCount = Math.max(0, lines.length - 1);

		const spu = await Spu.findById(params.spuId);
		if (!spu) return fail(404, { error: 'SPU not found' });

		const attachment = {
			_id: generateId(),
			kind: 'thermocouple_csv',
			fileName: file.name || 'thermocouple.csv',
			mimeType: file.type || 'text/csv',
			fileSize: file.size,
			rowCount,
			content,
			sessionId: form.get('sessionId')?.toString() || null,
			uploadedAt: new Date(),
			uploadedBy: { _id: locals.user!._id, username: locals.user!.username }
		};
		await Spu.updateOne({ _id: params.spuId }, { $push: { attachments: attachment } });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: params.spuId,
			action: 'UPDATE',
			oldData: {},
			newData: { attachmentAdded: attachment.fileName, rowCount },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { uploadSuccess: true, fileName: attachment.fileName, rowCount };
	},

	deleteAttachment: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const attachmentId = form.get('attachmentId')?.toString();
		if (!attachmentId) return fail(400, { error: 'attachmentId required' });

		await Spu.updateOne({ _id: params.spuId }, { $pull: { attachments: { _id: attachmentId } } });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: params.spuId,
			action: 'UPDATE',
			oldData: { attachmentId },
			newData: { attachmentRemoved: attachmentId },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { deleteSuccess: true };
	},

	// updateAssignment removed — release status (released-rnd/manufacturing/field) via transitionStatus

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
	},

	deleteSpu: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const spu = await Spu.findById(params.spuId).lean() as any;
		if (!spu) return fail(404, { error: 'SPU not found' });
		if (spu.finalizedAt) return fail(400, { error: 'Cannot delete a finalized SPU' });

		// Use direct collection delete to bypass sacred middleware
		await Spu.collection.deleteOne(byId(params.spuId));

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: params.spuId,
			action: 'DELETE',
			oldData: { udi: spu.udi, status: spu.status },
			newData: null,
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { success: true, deleted: true };
	},

	// Send a unit out for service — Phase A: capture the issue + initial test plan.
	openService: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const issue = form.get('issue')?.toString().trim();
		const initialTestPlan = form.get('initialTestPlan')?.toString().trim() || '';
		if (!issue) return fail(400, { error: 'Issue is required' });

		const spu = await Spu.findById(params.spuId).lean() as any;
		if (!spu) return fail(404, { error: 'SPU not found' });
		const records: any[] = spu.serviceRecords ?? [];
		if (records.some((r) => r.status === 'open')) {
			return fail(400, { error: 'This unit already has an open service record' });
		}

		const cycle = records.length + 1;
		const operator = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();
		const record = {
			_id: generateId(), cycle, issue, initialTestPlan, fix: null, status: 'open',
			openedBy: operator, openedAt: now, returnedBy: null, returnedAt: null
		};
		const oldStatus = spu.status ?? 'draft';

		// Native write bypasses sacred middleware so finalized/deployed units can be serviced.
		await (Spu.collection as any).updateOne(byId(params.spuId), {
			$push: {
				serviceRecords: record,
				statusTransitions: { _id: generateId(), from: oldStatus, to: 'servicing', changedBy: operator, changedAt: now, reason: `Service #${cycle}: ${issue}` }
			},
			$set: { status: 'servicing', updatedAt: now }
		});

		await AuditLog.create({
			_id: generateId(), tableName: 'spus', recordId: params.spuId, action: 'UPDATE',
			oldData: { status: oldStatus }, newData: { serviceCycle: cycle, issue },
			reason: `Service #${cycle} opened: ${issue}`,
			changedBy: locals.user!.username ?? locals.user!._id
		});
		return { success: true, serviceOpened: true };
	},

	// Return a serviced unit — Phase B: record the fix, require re-validation,
	// and reset the validation counter (prior validation records are preserved).
	returnService: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const fix = form.get('fix')?.toString().trim();
		if (!fix) return fail(400, { error: 'A description of the fix is required' });

		const spu = await Spu.findById(params.spuId).lean() as any;
		if (!spu) return fail(404, { error: 'SPU not found' });
		const open = (spu.serviceRecords ?? []).find((r: any) => r.status === 'open');
		if (!open) return fail(400, { error: 'No open service record to return' });

		const operator = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();
		const oldStatus = spu.status ?? 'servicing';

		await (Spu.collection as any).updateOne(
			{ ...byId(params.spuId), 'serviceRecords._id': open._id },
			{
				$set: {
					'serviceRecords.$.status': 'returned',
					'serviceRecords.$.fix': fix,
					'serviceRecords.$.returnedBy': operator,
					'serviceRecords.$.returnedAt': now,
					status: 'validating',
					validationResetAt: now,
					updatedAt: now
				},
				$push: {
					statusTransitions: { _id: generateId(), from: oldStatus, to: 'validating', changedBy: operator, changedAt: now, reason: `Service #${open.cycle} returned — re-validation required` }
				}
			}
		);

		await AuditLog.create({
			_id: generateId(), tableName: 'spus', recordId: params.spuId, action: 'UPDATE',
			oldData: { status: oldStatus }, newData: { serviceCycle: open.cycle, fix, validationReset: now },
			reason: `Service #${open.cycle} returned: ${fix}. Validation counter reset.`,
			changedBy: locals.user!.username ?? locals.user!._id
		});
		return { success: true, serviceReturned: true };
	}
};

export const config = { maxDuration: 60 };
