import { fail, redirect } from '@sveltejs/kit';
import { connectDB, ProcessConfiguration, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

const PROCESS_TYPE = 'cut_thermoseal';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	try {
		await connectDB();
		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		const steps = (config?.steps ?? []).map((s: any) => ({
			id: String(s._id),
			configId: String(config?._id ?? ''),
			stepNumber: s.stepNumber ?? 0,
			title: s.title ?? '',
			description: s.description ?? null,
			imageUrl: s.imageUrl ?? null,
			createdAt: s.createdAt?.toISOString?.() ?? new Date().toISOString(),
			updatedAt: s.updatedAt?.toISOString?.() ?? new Date().toISOString()
		}));
		return {
			steps,
			configId: String(config?._id ?? '')
		};
	} catch {
		return { steps: [], configId: '' };
	}
};

export const actions: Actions = {
	addStep: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		try {
			const data = await request.formData();
			const title = (data.get('title') as string)?.trim();
			const description = (data.get('description') as string)?.trim() || null;
			const stepNumber = Number(data.get('stepNumber') || 0);

			if (!title) return fail(400, { error: 'Title is required' });

			const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE });
			if (!config) return fail(404, { error: 'Process configuration not found' });

			const newStep = {
				_id: generateId(),
				stepNumber,
				title,
				description,
				imageUrl: null
			};

			await ProcessConfiguration.findByIdAndUpdate(config._id, {
				$push: { steps: newStep }
			});

			return { success: true, message: 'Step added' };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to add step' });
		}
	},

	editStep: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		try {
			const data = await request.formData();
			const id = data.get('id') as string;
			const title = (data.get('title') as string)?.trim();
			const description = (data.get('description') as string)?.trim() || null;
			const stepNumber = Number(data.get('stepNumber') || 0);

			if (!id) return fail(400, { error: 'Step ID required' });
			if (!title) return fail(400, { error: 'Title is required' });

			await ProcessConfiguration.updateOne(
				{ processType: PROCESS_TYPE, 'steps._id': id },
				{
					$set: {
						'steps.$.title': title,
						'steps.$.description': description,
						'steps.$.stepNumber': stepNumber
					}
				}
			);

			return { success: true, message: 'Step updated' };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to edit step' });
		}
	},

	deleteStep: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		try {
			const data = await request.formData();
			const id = data.get('id') as string;
			if (!id) return fail(400, { error: 'Step ID required' });

			await ProcessConfiguration.updateOne(
				{ processType: PROCESS_TYPE },
				{ $pull: { steps: { _id: id } } }
			);

			return { success: true, message: 'Step deleted' };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to delete step' });
		}
	},

	reorderSteps: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		try {
			const data = await request.formData();
			const orderedIds = JSON.parse((data.get('orderedIds') as string) || '[]') as string[];

			const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }) as any;
			if (!config) return fail(404, { error: 'Config not found' });

			for (let i = 0; i < orderedIds.length; i++) {
				await ProcessConfiguration.updateOne(
					{ processType: PROCESS_TYPE, 'steps._id': orderedIds[i] },
					{ $set: { 'steps.$.stepNumber': i + 1 } }
				);
			}

			return { success: true, message: 'Steps reordered' };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to reorder steps' });
		}
	}
};

export const config = { maxDuration: 60 };
