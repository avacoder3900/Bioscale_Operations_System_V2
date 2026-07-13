import { fail, redirect } from '@sveltejs/kit';
import { connectDB, WorkInstruction, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	await connectDB();

	const pageSize = 50;
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1);

	const [wis, totalCount] = await Promise.all([
		WorkInstruction.find().sort({ updatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
		WorkInstruction.countDocuments()
	]);

	return {
		workInstructions: wis.map((wi: any) => ({
			id: wi._id,
			title: wi.title ?? '',
			documentNumber: wi.documentNumber ?? '',
			version: wi.currentVersion ?? 1,
			status: wi.status ?? 'draft',
			category: wi.category ?? null,
			createdAt: wi.createdAt,
			updatedAt: wi.updatedAt
		})),
		instructions: wis.map((wi: any) => ({
			id: wi._id,
			title: wi.title ?? '',
			documentNumber: wi.documentNumber ?? '',
			version: wi.currentVersion ?? 1,
			status: wi.status ?? 'draft',
			category: wi.category ?? null,
			createdAt: wi.createdAt,
			updatedAt: wi.updatedAt
		})),
		page,
		pageSize,
		totalCount
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		await connectDB();
		const form = await request.formData();
		const title = form.get('title')?.toString().trim();
		const documentNumber = form.get('documentNumber')?.toString().trim();
		const category = form.get('category')?.toString().trim() || undefined;
		const content = form.get('content')?.toString() ?? '';

		if (!title || !documentNumber) return fail(400, { error: 'Title and document number required' });

		const id = generateId();
		const now = new Date();

		await WorkInstruction.create({
			_id: id,
			title,
			documentNumber,
			category,
			status: 'draft',
			currentVersion: 1,
			createdBy: locals.user?._id,
			versions: [{
				_id: generateId(),
				version: 1,
				content,
				createdAt: now,
				steps: []
			}]
		});

		await AuditLog.create({
			_id: generateId(), tableName: 'work_instructions', recordId: id,
			action: 'INSERT', newData: { title, documentNumber },
			changedAt: now, changedBy: locals.user?.username ?? 'system'
		});

		return { success: true };
	}
};
