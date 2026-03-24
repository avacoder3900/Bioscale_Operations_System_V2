import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Document, User, ElectronicSignature, AuditLog, generateId } from '$lib/server/db';
import bcrypt from 'bcryptjs';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'document:approve');
	await connectDB();
	const doc = await Document.findById(params.id).lean() as any;
	if (!doc) error(404, 'Document not found');

	let ownerUsername: string | null = null;
	if (doc.ownerId) {
		const owner = await User.findById(doc.ownerId).select('username').lean() as any;
		ownerUsername = owner?.username ?? null;
	}

	// Find the in_review revision
	const revision = (doc.revisions ?? []).find((r: any) => r.status === 'in_review');
	if (!revision) error(404, 'No pending revision found');

	let createdByUsername: string | null = null;
	if (revision.createdBy) {
		const creator = await User.findById(revision.createdBy).select('username').lean() as any;
		createdByUsername = creator?.username ?? null;
	}

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
			status: doc.status ?? 'draft',
			ownerId: doc.ownerId ?? null,
			ownerUsername
		},
		revision: {
			id: revision._id,
			revision: parseInt(revision.revision) || 0,
			content: revision.content ?? null,
			changeDescription: revision.changeDescription ?? null,
			status: revision.status,
			createdAt: revision.createdAt,
			createdByUsername
		},
		userName
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		requirePermission(locals.user, 'document:approve');
		await connectDB();
		const form = await request.formData();
		const decision = form.get('decision')?.toString() as 'approve' | 'reject';
		const comments = form.get('comments')?.toString() || undefined;
		const password = form.get('password')?.toString();
		const meaning = form.get('meaning')?.toString();

		if (!decision || !password || !meaning) {
			return fail(400, { error: 'Decision, password, and meaning are required' });
		}

		// Verify password for e-signature
		const user = await User.findById(locals.user?._id).lean() as any;
		if (!user) return fail(400, { error: 'User not found' });
		const validPassword = await bcrypt.compare(password, user.passwordHash);
		if (!validPassword) return fail(400, { error: 'Invalid password' });

		const doc = await Document.findById(params.id).lean() as any;
		if (!doc) error(404, 'Document not found');

		const revision = (doc.revisions ?? []).find((r: any) => r.status === 'in_review');
		if (!revision) return fail(400, { error: 'No pending revision found' });

		const now = new Date();
		const sigId = generateId();

		// Create electronic signature
		await ElectronicSignature.create({
			_id: sigId,
			userId: locals.user?._id,
			entityType: 'document_revision',
			entityId: revision._id,
			meaning,
			signedAt: now
		});

		if (decision === 'approve') {
			await Document.updateOne(
				{ _id: params.id, 'revisions._id': revision._id },
				{
					$set: {
						'revisions.$.status': 'approved',
						'revisions.$.approvedAt': now,
						'revisions.$.approvedBy': locals.user?._id,
						'revisions.$.approvalSignatureId': sigId,
						currentRevision: revision.revision,
						status: 'approved',
						effectiveDate: now
					}
				}
			);
		} else {
			await Document.updateOne(
				{ _id: params.id, 'revisions._id': revision._id },
				{ $set: { 'revisions.$.status': 'draft', status: 'draft' } }
			);
		}

		await AuditLog.create({
			_id: generateId(), tableName: 'documents', recordId: params.id,
			action: 'UPDATE', newData: { decision, revisionId: revision._id, comments },
			changedAt: now, changedBy: locals.user?.username ?? 'system'
		});

		redirect(303, `/documents/${params.id}`);
	}
};
