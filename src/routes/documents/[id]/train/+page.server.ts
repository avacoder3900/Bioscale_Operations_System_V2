import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, Document, User, ElectronicSignature, AuditLog, generateId } from '$lib/server/db';
import bcrypt from 'bcryptjs';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	await connectDB();
	const doc = await Document.findById(params.id).lean() as any;
	if (!doc) error(404, 'Document not found');

	const currentRev = (doc.revisions ?? []).find(
		(r: any) => r.status === 'approved' && r.revision === doc.currentRevision
	) ?? (doc.revisions ?? []).slice(-1)[0];

	if (!currentRev) error(404, 'No revision found for training');

	// Check if user has already trained on this revision
	const userId = locals.user?._id;
	const alreadyTrained = (currentRev.trainingRecords ?? []).some(
		(tr: any) => tr.userId === userId
	);

	const userName = locals.user
		? [locals.user.firstName, locals.user.lastName].filter(Boolean).join(' ') ||
		  locals.user.username
		: '';

	return {
		document: {
			id: doc._id,
			documentNumber: doc.documentNumber ?? '',
			title: doc.title ?? '',
			category: doc.category ?? null,
			currentRevision: parseInt(doc.currentRevision) || 0,
			status: doc.status ?? 'draft'
		},
		revision: {
			id: currentRev._id,
			revision: parseInt(currentRev.revision) || 0,
			content: currentRev.content ?? null,
			changeDescription: currentRev.changeDescription ?? null
		},
		alreadyTrained,
		userName
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		await connectDB();
		const form = await request.formData();
		const notes = form.get('notes')?.toString() || undefined;
		const password = form.get('password')?.toString();
		const meaning = form.get('meaning')?.toString();

		if (!password || !meaning) return fail(400, { error: 'Password and meaning are required' });

		const user = await User.findById(locals.user?._id).lean() as any;
		if (!user) return fail(400, { error: 'User not found' });
		const validPassword = await bcrypt.compare(password, user.passwordHash);
		if (!validPassword) return fail(400, { error: 'Invalid password' });

		const doc = await Document.findById(params.id).lean() as any;
		if (!doc) error(404, 'Document not found');

		const currentRev = (doc.revisions ?? []).find(
			(r: any) => r.revision === doc.currentRevision
		);
		if (!currentRev) return fail(400, { error: 'No current revision found' });

		const now = new Date();
		const sigId = generateId();
		const trainingId = generateId();

		// Create electronic signature
		await ElectronicSignature.create({
			_id: sigId,
			userId: locals.user?._id,
			entityType: 'document_training',
			entityId: trainingId,
			meaning,
			signedAt: now
		});

		// Add training record to the revision
		await Document.updateOne(
			{ _id: params.id, 'revisions._id': currentRev._id },
			{
				$push: {
					'revisions.$.trainingRecords': {
						_id: trainingId,
						userId: locals.user?._id,
						username: locals.user?.username ?? '',
						trainedAt: now,
						signatureId: sigId,
						notes
					}
				}
			}
		);

		await AuditLog.create({
			_id: generateId(), tableName: 'documents', recordId: params.id,
			action: 'UPDATE', newData: { trainingCompleted: true, revisionId: currentRev._id },
			changedAt: now, changedBy: locals.user?.username ?? 'system'
		});

		redirect(303, `/documents/${params.id}`);
	}
};

export const config = { maxDuration: 60 };
