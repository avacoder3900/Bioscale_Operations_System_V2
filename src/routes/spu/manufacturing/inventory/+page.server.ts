import { redirect } from '@sveltejs/kit';
import { connectDB, ManufacturingMaterial, ManufacturingMaterialTransaction } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const materials = await ManufacturingMaterial.find().sort({ name: 1 }).lean();

	return {
		materials: materials.map((m: any) => ({
			id: m._id,
			name: m.name ?? null,
			partNumber: null,
			currentStock: m.currentQuantity ?? 0,
			unit: m.unit ?? null,
			reorderPoint: null,
			category: null
		}))
	};
};

export const actions: Actions = {
	addMaterial: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		await ManufacturingMaterial.create({
			name: data.get('name') as string,
			unit: data.get('unit') as string,
			currentQuantity: 0,
			recentTransactions: [],
			updatedAt: new Date()
		});
		return { success: true };
	},

	recordTransaction: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const materialId = data.get('materialId') as string;
		const transactionType = data.get('transactionType') as string;
		const quantity = Number(data.get('quantity'));
		const notes = data.get('notes') as string;

		const material = await ManufacturingMaterial.findById(materialId).lean() as any;
		if (!material) return { error: 'Material not found' };

		const quantityBefore = material.currentQuantity ?? 0;
		const quantityChanged = transactionType === 'consume' ? -Math.abs(quantity) : Math.abs(quantity);
		const quantityAfter = quantityBefore + quantityChanged;
		const now = new Date();

		// Create immutable transaction log
		await ManufacturingMaterialTransaction.create({
			materialId,
			transactionType,
			quantityChanged,
			quantityBefore,
			quantityAfter,
			operatorId: locals.user._id,
			notes: notes || undefined,
			createdAt: now
		});

		// Update material with new quantity and embed in recent transactions (keep last 100)
		const txEntry = {
			transactionType,
			quantityChanged,
			quantityBefore,
			quantityAfter,
			operatorId: locals.user._id,
			notes: notes || undefined,
			createdAt: now
		};

		await ManufacturingMaterial.findByIdAndUpdate(materialId, {
			$set: { currentQuantity: quantityAfter, updatedAt: now },
			$push: {
				recentTransactions: {
					$each: [txEntry],
					$slice: -100
				}
			}
		});

		return { success: true };
	}
};
