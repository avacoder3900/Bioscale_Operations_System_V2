import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, ManufacturingMaterial, ManufacturingMaterialTransaction,
	ManufacturingSettings, PartDefinition, generateId
} from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [materials, settingsDoc] = await Promise.all([
		ManufacturingMaterial.find().sort({ name: 1 }).lean(),
		ManufacturingSettings.findById('default').lean()
	]);

	const general = (settingsDoc as any)?.general ?? {};
	const cartridgesPerSheet = general.cartridgesPerLaserCutSheet ?? 1;

	// FIX-02: Build materials list with partNumber from the model (denormalized)
	const serialized = (materials as any[]).map((m: any) => ({
		materialId: m._id,
		name: m.name ?? null,
		unit: m.unit ?? null,
		currentQuantity: m.currentQuantity ?? 0,
		updatedAt: m.updatedAt ?? m.createdAt ?? new Date().toISOString(),
		// FIX-02: include linked part info
		partDefinitionId: m.partDefinitionId ?? null,
		partNumber: m.partNumber ?? null
	}));

	// Derived: "Individual Backs Available" = laser-cut sheets × cartridgesPerSheet
	// Find the laser-cut output material
	const laserCutMaterial = (materials as any[]).find((m: any) =>
		m.name && /laser.?cut|cut.?sub|substrate/i.test(m.name)
	);
	const laserCutQty = laserCutMaterial?.currentQuantity ?? 0;
	const individualBacks = laserCutQty * cartridgesPerSheet;

	return {
		materials: JSON.parse(JSON.stringify(serialized)),
		derived: {
			individualBacks,
			cartridgesPerSheet
		}
	};
};

export const actions: Actions = {
	/** Add a new material, optionally linked to a PartDefinition */
	addMaterial: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const name = data.get('name') as string;
		const unit = data.get('unit') as string;
		const partDefinitionId = (data.get('partDefinitionId') as string) || null;

		if (!name) return fail(400, { error: 'Name is required' });

		// FIX-02: Look up partNumber if partDefinitionId is provided
		let partNumber: string | null = null;
		if (partDefinitionId) {
			const part = await PartDefinition.findById(partDefinitionId).lean() as any;
			partNumber = part?.partNumber ?? null;
		}

		await ManufacturingMaterial.create({
			_id: generateId(),
			name,
			unit: unit || 'pcs',
			currentQuantity: 0,
			partDefinitionId,
			partNumber,
			recentTransactions: [],
			updatedAt: new Date()
		});
		return { success: true };
	},

	/** Record a transaction against a material. Also syncs PartDefinition.inventoryCount if linked. */
	recordTransaction: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const materialId = data.get('materialId') as string;
		const transactionType = data.get('transactionType') as string;
		const quantity = Number(data.get('quantity'));
		const notes = data.get('notes') as string;

		const material = await ManufacturingMaterial.findById(materialId).lean() as any;
		if (!material) return fail(404, { error: 'Material not found' });

		const quantityBefore = material.currentQuantity ?? 0;
		const quantityChanged = transactionType === 'consume' ? -Math.abs(quantity) : Math.abs(quantity);
		const quantityAfter = quantityBefore + quantityChanged;
		const now = new Date();

		// Create immutable transaction log
		await ManufacturingMaterialTransaction.create({
			_id: generateId(),
			materialId,
			transactionType,
			quantityChanged,
			quantityBefore,
			quantityAfter,
			operatorId: locals.user._id,
			notes: notes || undefined,
			createdAt: now
		});

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
			$push: { recentTransactions: { $each: [txEntry], $slice: -100 } }
		});

		// FIX-02: If material is linked to a PartDefinition, sync inventoryCount
		if (material.partDefinitionId) {
			await PartDefinition.findByIdAndUpdate(material.partDefinitionId, {
				$inc: { inventoryCount: quantityChanged }
			});
		}

		return { success: true };
	}
};
