import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssemblySession, Spu, ElectronicSignature, generateId, AuditLog } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId) {
		return {
			spu: null as { udi: string } | null,
			elapsedMs: 0,
			scannedParts: [] as { partNumber: string; lotNumber: string; scannedAt: Date }[],
			userName: locals.user?.username ?? ''
		};
	}

	const session = await AssemblySession.findById(sessionId).lean() as any;
	if (!session) {
		return {
			spu: null as { udi: string } | null,
			elapsedMs: 0,
			scannedParts: [] as { partNumber: string; lotNumber: string; scannedAt: Date }[],
			userName: locals.user?.username ?? ''
		};
	}

	const spuDoc = session.spuId ? await Spu.findById(session.spuId).lean() as any : null;

	const elapsedMs = session.completedAt && session.startedAt
		? new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()
		: session.startedAt
			? Date.now() - new Date(session.startedAt).getTime()
			: 0;

	const userName = locals.user
		? [locals.user.firstName, locals.user.lastName].filter(Boolean).join(' ') ||
		  locals.user.username
		: '';

	return {
		spu: spuDoc ? { udi: spuDoc.udi ?? '' } : null as { udi: string } | null,
		elapsedMs,
		scannedParts: (session.stepRecords ?? [])
			.flatMap((step: any) => step.scannedComponents ?? [])
			.map((part: any): { partNumber: string; lotNumber: string; scannedAt: Date } => ({
				partNumber: part.partNumber ?? '',
				lotNumber: part.lotNumber ?? '',
				scannedAt: part.scannedAt ?? new Date()
			})),
		userName
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sessionId = form.get('sessionId')?.toString();
		if (!sessionId) return fail(400, { error: 'Session ID required' });

		const session = await AssemblySession.findById(sessionId).lean();
		if (!session) return fail(404, { error: 'Session not found' });
		const s = session as any;

		if (s.status === 'completed') return fail(400, { error: 'Session already completed' });

		// Create electronic signature
		const meaning = form.get('meaning')?.toString() || 'Assembly completed and verified';
		const sigId = generateId();
		await ElectronicSignature.create({
			_id: sigId,
			userId: locals.user!._id,
			entityType: 'assembly_session',
			entityId: sessionId,
			meaning,
			signedAt: new Date(),
			dataHash: ''
		});

		// Complete the session
		await AssemblySession.updateOne({ _id: sessionId }, {
			$set: { status: 'completed', completedAt: new Date() }
		});

		// Copy assembly data into SPU (SACRED document)
		if (s.spuId) {
			const assemblyData: Record<string, any> = {
				'assembly.sessionId': sessionId,
				'assembly.workInstructionId': s.workInstructionId,
				'assembly.workInstructionVersion': s.workInstructionVersion,
				'assembly.workInstructionTitle': s.workInstructionTitle,
				'assembly.startedAt': s.startedAt,
				'assembly.completedAt': new Date(),
				'assembly.operator': { _id: locals.user!._id, username: locals.user!.username },
				'assembly.workstationId': s.workstationId,
				'assembly.stepRecords': s.stepRecords ?? [],
				'signature._id': sigId,
				'signature.userId': locals.user!._id,
				'signature.username': locals.user!.username,
				'signature.meaning': meaning,
				'signature.signedAt': new Date(),
				assemblyStatus: 'completed',
				status: 'assembled'
			};

			await Spu.updateOne({ _id: s.spuId }, { $set: assemblyData });
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: sessionId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});

		redirect(303, `/spu/${s.spuId}`);
	}
};

export const config = { maxDuration: 60 };
