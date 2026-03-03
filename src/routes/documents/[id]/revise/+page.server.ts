import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Document, User, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'document:write');
	await connectDB();
	const doc = await Document.findById(params.id).lean() as any;
	if (!doc) error(404, 'Document not found');

	let ownerUsername: string | null = null;
	if (doc.ownerId) {
		const owner = await User.findById(doc.ownerId).select('username').lean() as any;
		ownerUsername = owner?.username ?? null;
	}

	const latestRev = (doc.revisions ?? []).sort((a: any, b: any) =>
		(parseInt(b.revision) || 0) - (parseInt(a.revision) || 0)
	)[0];

	return {
		document: {
			id: doc._id,
			documentNumber: doc.documentNumber ?? '',
			title: doc.title ?? '',
			category: doc.category ?? null,
			currentRevision: String(parseInt(doc.currentRevision) || 0),
			status: doc.status ?? 'draft',
			ownerId: doc.ownerId ?? null,
			ownerUsername
		},
		latestContent: latestRev?.content ?? null
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'document:write');
		await connectDB();
		const form = await request.formData();
		const content = form.get('content')?.toString() ?? '';
		const changeDescription = form.get('changeDescription')?.toString() || undefined;

		if (!content.trim()) return fail(400, { error: 'Content is required' });

		const doc = await Document.findById(params.id).lean() as any;
		if (!doc) error(404, 'Document not found');

		const currentRev = parseInt(doc.currentRevision) || 0;
		const newRevNum = currentRev + 1;
		const revisionId = generateId();
		const now = new Date();

		await Document.updateOne({ _id: params.id }, {
			$push: {
				revisions: {
					_id: revisionId,
					revision: String(newRevNum),
					content,
					changeDescription,
					status: 'in_review',
					createdAt: now,
					createdBy: locals.user?._id,
					trainingRecords: []
				}
			},
			$set: { status: 'in_review' }
		});

		await AuditLog.create({
			_id: generateId(), tableName: 'documents', recordId: params.id,
			action: 'UPDATE', newData: { revision: newRevNum, changeDescription },
			changedAt: now, changedBy: locals.user?.username ?? 'system'
		});

		redirect(303, `/documents/${params.id}`);
	}
};
