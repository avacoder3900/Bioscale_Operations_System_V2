import { fail, redirect, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, WorkInstruction, AuditLog, generateId } from '$lib/server/db';
import {
	inductSpuWiVersion,
	rejectSpuWiVersion,
	getSpuWorkInstructionDoc,
	findVersion
} from '$lib/server/services/spu-work-instruction';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requirePermission(locals.user, 'spu:write');
	await connectDB();

	const versionId = params.versionId;
	const wiId = url.searchParams.get('wi');

	const wi: any = wiId
		? await WorkInstruction.findById(wiId).lean()
		: await getSpuWorkInstructionDoc().then((d) => (d ? d.toObject() : null));
	if (!wi) throw error(404, 'Work instruction not found');

	const version = findVersion(wi, versionId);
	if (!version) throw error(404, 'Version not found');

	const isActive = wi.currentVersion === version.version && wi.status === 'active';

	const totalScans = (version.steps ?? []).reduce(
		(n: number, s: any) => n + (s.fieldDefinitions ?? []).length,
		0
	);
	const distinctParts = new Set<string>();
	for (const s of version.steps ?? []) {
		for (const p of s.partRequirements ?? []) distinctParts.add(p.partNumber);
	}

	return {
		wiId: wi._id,
		isActive,
		version: JSON.parse(
			JSON.stringify({
				id: version._id,
				version: version.version,
				parsedAt: version.parsedAt,
				steps: version.steps ?? []
			})
		),
		summary: {
			stepCount: (version.steps ?? []).length,
			distinctParts: distinctParts.size,
			totalScans
		}
	};
};

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const versionId = params.versionId;
		const form = await request.formData();
		const wiId = form.get('wiId')?.toString();
		const payload = form.get('payload')?.toString();
		if (!wiId || !payload) return fail(400, { error: 'Missing wiId or payload' });

		let edits: any;
		try {
			edits = JSON.parse(payload);
		} catch {
			return fail(400, { error: 'Invalid payload JSON' });
		}
		if (!Array.isArray(edits.steps)) return fail(400, { error: 'payload.steps required' });

		const sanitizedSteps = edits.steps.map((s: any, idx: number) => ({
			_id: typeof s._id === 'string' ? s._id : generateId(),
			stepNumber: Number.isFinite(s.stepNumber) ? s.stepNumber : idx + 1,
			title: String(s.title ?? `Step ${idx + 1}`).slice(0, 500),
			content: String(s.content ?? '').slice(0, 50_000),
			requiresScan: Array.isArray(s.fieldDefinitions) && s.fieldDefinitions.length > 0,
			partRequirements: (s.partRequirements ?? []).map((p: any) => ({
				_id: typeof p._id === 'string' ? p._id : generateId(),
				partNumber: String(p.partNumber ?? '').toUpperCase().slice(0, 64),
				partDefinitionId: p.partDefinitionId ?? undefined,
				quantity: Math.max(1, Math.min(999, parseInt(p.quantity, 10) || 1)),
				notes: p.notes ?? undefined
			})),
			fieldDefinitions: (s.fieldDefinitions ?? []).map((f: any, fi: number) => ({
				_id: typeof f._id === 'string' ? f._id : generateId(),
				fieldName: String(f.fieldName ?? `field_${idx + 1}_${fi + 1}`)
					.replace(/[^A-Za-z0-9_]/g, '_')
					.slice(0, 100),
				fieldLabel: String(f.fieldLabel ?? '').slice(0, 200),
				fieldType: ['barcode_scan', 'manual_entry', 'date_picker', 'dropdown'].includes(f.fieldType)
					? f.fieldType
					: 'barcode_scan',
				isRequired: f.isRequired !== false,
				validationPattern: f.validationPattern ?? undefined,
				options: f.options ?? undefined,
				barcodeFieldMapping: String(f.barcodeFieldMapping ?? '').toUpperCase().slice(0, 64),
				sortOrder: Number.isFinite(f.sortOrder) ? f.sortOrder : fi + 1
			}))
		}));

		await WorkInstruction.updateOne(
			{ _id: wiId, 'versions._id': versionId },
			{ $set: { 'versions.$.steps': sanitizedSteps } }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'work_instructions',
			recordId: wiId,
			action: 'UPDATE',
			changedBy: locals.user!.username,
			changedAt: new Date(),
			newData: { event: 'review_save', versionId }
		});

		return { saved: true };
	},

	induct: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const versionId = params.versionId;
		const form = await request.formData();
		const wiId = form.get('wiId')?.toString();
		if (!wiId) return fail(400, { error: 'Missing wiId' });

		try {
			await inductSpuWiVersion(wiId, versionId, {
				_id: locals.user!._id,
				username: locals.user!.username
			});
		} catch (err: any) {
			return fail(400, { error: err?.message ?? 'Induct failed' });
		}

		redirect(303, '/spu/work-instruction');
	},

	reject: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const versionId = params.versionId;
		const form = await request.formData();
		const wiId = form.get('wiId')?.toString();
		if (!wiId) return fail(400, { error: 'Missing wiId' });

		await rejectSpuWiVersion(wiId, versionId, {
			_id: locals.user!._id,
			username: locals.user!.username
		});

		redirect(303, '/spu/work-instruction');
	}
};

export const config = { maxDuration: 60 };
