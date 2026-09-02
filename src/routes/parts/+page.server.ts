import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, generateId, AuditLog, InventoryTransaction } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	// Look up PT-CT-101 so we can exclude viewer1's seeded thermoseal transactions
	const thermosealPart = await PartDefinition.findOne({ partNumber: 'PT-CT-101' }).select('_id').lean() as any;
	const thermosealPartId = thermosealPart?._id;

	const [allSpuParts, cartridgePartDocs, txAgg] = await Promise.all([
		PartDefinition.find({ $or: [{ bomType: 'spu' }, { bomType: { $exists: false } }] })
			.sort({ sortOrder: 1, partNumber: 1 }).lean(),
		PartDefinition.find({ bomType: 'cartridge', isActive: true })
			.sort({ partNumber: 1 }).lean(),
		InventoryTransaction.aggregate([
			{ $match: {
				$nor: [
					{ performedBy: { $in: ['contracttest', 'operator1', 'nick'] } },
					...(thermosealPartId
						? [{ performedBy: '6qL9_4SC4lYXTrMGZTAui', partDefinitionId: thermosealPartId }]
						: [])
				]
			}},
			{ $sort: { createdAt: 1 } },
			{ $group: {
				_id: '$partDefinitionId',
				totalQuantity: { $sum: '$quantity' },
				txCount: { $sum: 1 },
				lastTxAt: { $max: '$createdAt' },
				lastSource: { $last: '$source' }
			}}
		])
	]);

	// Only BOM parts are listed; isBom:false parts are retired from the SPU BOM.
	// Used-part variants (SPU-INV-09) live on their own tab, not in the SPU list.
	const spuParts = (allSpuParts as any[]).filter((p: any) => p.isBom !== false && !p.usedVariantOf);

	// Tied-up-in-subassemblies math (SPU-INV-09): pristine subassemblies only —
	// used-variant subs carry an informational component list but don't count.
	const partCostById = new Map<string, number | null>(
		(allSpuParts as any[]).map((p: any) => [p._id, parseFloat(p.unitCost) || null])
	);
	const tiedUp: Record<string, number> = {};
	for (const sub of spuParts.filter((p: any) => p.isSubassembly)) {
		for (const c of sub.components ?? []) {
			tiedUp[c.partDefinitionId] = (tiedUp[c.partDefinitionId] ?? 0) + (c.quantity ?? 1) * (sub.inventoryCount ?? 0);
		}
	}

	// Map SPU parts to expected shape
	const items = (spuParts as any[]).map((p) => {
		// Subassemblies have no cost of their own — derive from children.
		const cost = p.isSubassembly
			? (p.components ?? []).reduce((sum: number, c: any) => {
					const cc = partCostById.get(c.partDefinitionId);
					return cc != null ? sum + cc * (c.quantity ?? 1) : sum;
				}, 0) || null
			: parseFloat(p.unitCost) || null;
		const invCount = p.inventoryCount ?? 0;
		return {
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			description: p.description ?? null,
			category: p.category ?? null,
			supplier: p.supplier ?? null,
			manufacturer: p.manufacturer ?? null,
			barcode: p.barcode ?? null,
			inventoryCount: invCount,
			inventorySource: p.inventorySource ?? 'box_estimate',
			quantityPerUnit: p.quantityPerUnit ?? null,
			unitCost: cost,
			totalValue: cost != null ? cost * invCount : null,
			minimumStockLevel: p.minimumOrderQty ?? 0,
			leadTimeDays: p.leadTimeDays ?? null,
			isSubassembly: !!p.isSubassembly,
			components: (p.components ?? []).map((c: any) => ({
				partDefinitionId: c.partDefinitionId,
				partNumber: c.partNumber ?? '',
				name: c.name ?? '',
				quantity: c.quantity ?? 1
			})),
			tiedUpInSubs: tiedUp[p._id] ?? 0
		};
	});

	// Remove entries with no cost breakdown (subassemblies stay regardless —
	// their derived cost may legitimately be null)
	const itemsWithCost = items.filter(i => i.isSubassembly || (i.unitCost != null && i.unitCost > 0));
	const itemsNoCost = items.filter(i => i.unitCost == null || i.unitCost <= 0);
	if (itemsNoCost.length > 0) {
		console.log(`[parts] Filtered out ${itemsNoCost.length} items with no cost data`);
	}

	// Cartridge parts (now from PartDefinition with bomType='cartridge')
	const cartridgeParts = (cartridgePartDocs as any[]).map((p) => {
		const cost = parseFloat(p.unitCost) || null;
		const invCount = p.inventoryCount ?? 0;
		return {
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			category: p.category ?? null,
			quantityPerUnit: p.quantityPerUnit ?? null,
			inventoryCount: invCount,
			inventorySource: p.inventorySource ?? 'box_estimate',
			unitCost: cost,
			totalValue: cost != null ? cost * invCount : null,
			manufacturer: p.manufacturer ?? null,
			supplier: p.supplier ?? null,
			barcode: p.barcode ?? null,
			minimumStockLevel: p.minimumOrderQty ?? 0,
			leadTimeDays: p.leadTimeDays ?? null
		};
	});

	// Low stock items (from both parts and BOM)
	const lowStockItems = [
		...itemsWithCost.filter(i => i.inventoryCount < i.minimumStockLevel && i.minimumStockLevel > 0),
		...cartridgeParts.filter(i => i.inventoryCount < i.minimumStockLevel && i.minimumStockLevel > 0)
	].map(i => ({
		id: i.id,
		partNumber: i.partNumber,
		name: i.name,
		inventoryCount: i.inventoryCount,
		minimumStockLevel: i.minimumStockLevel
	}));

	// Cartridge BOM summary
	const cartridgeBomSummary = cartridgeParts.length > 0 ? {
		totalParts: cartridgeParts.length,
		totalValue: cartridgeParts.reduce((sum, p) => sum + (p.totalValue ?? 0), 0),
		categories: [...new Set(cartridgeParts.map(p => p.category).filter(Boolean))] as string[],
		lowStockCount: cartridgeParts.filter(p => p.inventoryCount < p.minimumStockLevel && p.minimumStockLevel > 0).length
	} : null;

	// Computed stats
	const allCategories = [...new Set(items.map(i => i.category).filter(Boolean))] as string[];
	const stats = {
		total: itemsWithCost.length,
		categories: allCategories.length,
		totalInventoryValue: itemsWithCost.reduce((sum, i) => sum + (i.totalValue ?? 0), 0),
		lowStockCount: lowStockItems.length
	};

	// Low inventory: zero/negative + low (bottom 10 that are > 0)
	const inventoryFields = (i: typeof itemsWithCost[0]) => ({
		id: i.id, partNumber: i.partNumber, name: i.name,
		inventoryCount: i.inventoryCount, leadTimeDays: i.leadTimeDays,
		inventorySource: i.inventorySource ?? 'box_estimate'
	});
	const zeroOrNegative = items.filter(i => i.inventoryCount <= 0).map(inventoryFields);
	const lowPositive = [...itemsWithCost]
		.filter(i => i.inventoryCount > 0)
		.sort((a, b) => a.inventoryCount - b.inventoryCount)
		.slice(0, 10)
		.map(inventoryFields);
	const lowestInventory = [...zeroOrNegative, ...lowPositive];

	// Transaction-based scanned inventory
	const txMap = new Map(txAgg.map((t: any) => [t._id, t]));
	const allParts = [...(allSpuParts as any[]), ...(cartridgePartDocs as any[])];
	const scannedItems = allParts
		.filter((p: any) => txMap.has(p._id))
		.map((p: any) => {
			const tx = txMap.get(p._id)!;
			const cost = parseFloat(p.unitCost) || null;
			return {
				id: p._id,
				partNumber: p.partNumber ?? '',
				name: p.name ?? '',
				category: p.category ?? null,
				stock: tx.totalQuantity,
				unitCost: cost,
				totalValue: cost ? cost * tx.totalQuantity : null,
				txCount: tx.txCount,
				lastTxAt: tx.lastTxAt,
				lastSource: tx.lastSource ?? 'unknown'
			};
		})
		.sort((a, b) => a.partNumber.localeCompare(b.partNumber));

	const scannedSummary = {
		totalParts: scannedItems.length,
		totalTransactions: scannedItems.reduce((s, i) => s + i.txCount, 0),
		totalValue: scannedItems.reduce((s, i) => s + (i.totalValue ?? 0), 0)
	};

	// Used-part variants tab (SPU-INV-09)
	const usedById = new Map((allSpuParts as any[]).map((p: any) => [p._id, p]));
	const usedParts = (allSpuParts as any[])
		.filter((p: any) => p.usedVariantOf)
		.map((p: any) => {
			const base = usedById.get(p.usedVariantOf);
			return {
				id: p._id,
				partNumber: p.partNumber ?? '',
				name: p.name ?? '',
				category: p.category ?? null,
				inventoryCount: p.inventoryCount ?? 0,
				isSubassembly: !!p.isSubassembly,
				basePartId: p.usedVariantOf,
				basePartNumber: base?.partNumber ?? '?',
				baseName: base?.name ?? '?'
			};
		})
		.sort((a, b) => a.partNumber.localeCompare(b.partNumber));

	// Parts eligible for a new used variant: SPU parts (incl. subassemblies)
	// that don't already have one.
	const haveVariant = new Set((allSpuParts as any[]).filter((p: any) => p.usedVariantOf).map((p: any) => p.usedVariantOf));
	const usedVariantCandidates = spuParts
		.filter((p: any) => !haveVariant.has(p._id))
		.map((p: any) => ({ id: p._id, partNumber: p.partNumber ?? '', name: p.name ?? '' }))
		.sort((a: any, b: any) => a.partNumber.localeCompare(b.partNumber));

	// Non-subassembly parts pickable as subassembly children.
	const subassemblyChildCandidates = spuParts
		.filter((p: any) => !p.isSubassembly)
		.map((p: any) => ({ id: p._id, partNumber: p.partNumber ?? '', name: p.name ?? '' }))
		.sort((a: any, b: any) => a.partNumber.localeCompare(b.partNumber));

	return {
		items: itemsWithCost,
		usedParts,
		usedVariantCandidates,
		subassemblyChildCandidates,
		cartridgeParts,
		scannedItems: JSON.parse(JSON.stringify(scannedItems)),
		scannedSummary,
		cartridgeBomSummary,
		lowStockItems,
		lowestInventory,
		stats,
		categories: allCategories
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const partNumber = form.get('partNumber')?.toString().trim();
		const name = form.get('name')?.toString().trim();
		if (!partNumber || !name) return fail(400, { error: 'Part number and name are required' });

		const existing = await PartDefinition.findOne({ partNumber });
		if (existing) return fail(400, { error: 'Part number already exists' });

		await PartDefinition.create({
			_id: generateId(),
			partNumber,
			name,
			description: form.get('description')?.toString().trim() || undefined,
			category: form.get('category')?.toString().trim() || undefined,
			unitOfMeasure: form.get('unit')?.toString().trim() || 'ea',
			minimumOrderQty: form.get('reorderPoint') ? Number(form.get('reorderPoint')) : undefined,
			createdBy: locals.user!._id
		});
		return { success: true };
	},

	// ── SPU-INV-09: used-part variants + subassemblies ───────────────────────

	createUsedVariant: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const basePartId = form.get('basePartId')?.toString();
		if (!basePartId) return fail(400, { error: 'Pick a part to make a used variant of' });

		const base = await PartDefinition.findById(basePartId).lean() as any;
		if (!base) return fail(404, { error: 'Base part not found' });
		if (base.usedVariantOf) return fail(400, { error: 'Cannot make a used variant of a used variant' });
		const existing = await PartDefinition.findOne({ usedVariantOf: basePartId }).lean();
		if (existing) return fail(400, { error: 'A used variant of this part already exists' });

		const _id = generateId();
		await PartDefinition.create({
			_id,
			partNumber: `${base.partNumber}-USED`,
			name: `${base.name} (Used)`,
			description: `Used variant of ${base.partNumber}`,
			category: base.category,
			unitOfMeasure: base.unitOfMeasure,
			bomType: 'spu',
			usedVariantOf: basePartId,
			// Counts start at 0 and are adjusted manually — creating a variant
			// never touches the pristine part's count (Jacob, SPU-INV-09).
			inventoryCount: 0,
			isSubassembly: !!base.isSubassembly,
			components: base.components ?? undefined,
			createdBy: locals.user!._id
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: _id,
			action: 'INSERT',
			newData: { usedVariantOf: basePartId, partNumber: `${base.partNumber}-USED` },
			reason: 'Used-part variant created (SPU-INV-09)',
			changedBy: locals.user!.username ?? locals.user!._id
		});
		return { success: true, message: `Created ${base.partNumber}-USED` };
	},

	adjustUsedCount: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const partId = form.get('partId')?.toString();
		const delta = Number(form.get('delta'));
		if (!partId || !Number.isFinite(delta) || delta === 0) return fail(400, { error: 'Invalid adjustment' });

		const part = await PartDefinition.findById(partId).lean() as any;
		if (!part?.usedVariantOf) return fail(404, { error: 'Used part not found' });
		const next = (part.inventoryCount ?? 0) + delta;
		if (next < 0) return fail(400, { error: 'Count cannot go negative' });

		await PartDefinition.updateOne({ _id: partId }, { $set: { inventoryCount: next } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: partId,
			action: 'UPDATE',
			oldData: { inventoryCount: part.inventoryCount ?? 0 },
			newData: { inventoryCount: next },
			reason: 'Used-part count adjusted',
			changedBy: locals.user!.username ?? locals.user!._id
		});
		return { success: true, message: `${part.partNumber}: ${next}` };
	},

	createSubassembly: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const partNumber = form.get('partNumber')?.toString().trim();
		const name = form.get('name')?.toString().trim();
		let componentsRaw: { id: string; quantity: number }[];
		try {
			componentsRaw = JSON.parse(form.get('components')?.toString() ?? '[]');
		} catch {
			return fail(400, { error: 'Invalid component list' });
		}
		if (!partNumber || !name) return fail(400, { error: 'Part number and name are required' });
		if (!Array.isArray(componentsRaw) || componentsRaw.length === 0) {
			return fail(400, { error: 'Add at least one component part' });
		}
		if (await PartDefinition.findOne({ partNumber }).lean()) {
			return fail(400, { error: 'Part number already exists' });
		}

		const children = await PartDefinition.find({ _id: { $in: componentsRaw.map((c) => c.id) } }).lean() as any[];
		const childById = new Map(children.map((c) => [c._id, c]));
		const components = [];
		for (const c of componentsRaw) {
			const child = childById.get(c.id);
			if (!child) return fail(400, { error: `Component part ${c.id} not found` });
			if (child.isSubassembly) return fail(400, { error: 'Subassemblies cannot nest' });
			const quantity = Math.max(1, Math.floor(Number(c.quantity) || 1));
			components.push({ partDefinitionId: child._id, partNumber: child.partNumber, name: child.name, quantity });
		}

		const _id = generateId();
		await PartDefinition.create({
			_id, partNumber, name,
			description: form.get('description')?.toString().trim() || undefined,
			category: form.get('category')?.toString().trim() || 'Subassembly',
			bomType: 'spu',
			isSubassembly: true,
			components,
			inventoryCount: 0,
			createdBy: locals.user!._id
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: _id,
			action: 'INSERT',
			newData: { partNumber, isSubassembly: true, components: components.map((c) => `${c.quantity}× ${c.partNumber}`) },
			reason: 'Subassembly created (SPU-INV-09)',
			changedBy: locals.user!.username ?? locals.user!._id
		});
		return { success: true, message: `Created subassembly ${partNumber}` };
	},

	buildSubassembly: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const subId = form.get('subId')?.toString();
		const qty = Math.floor(Number(form.get('qty')));
		const mode = form.get('mode')?.toString(); // 'denovo' | 'stock'
		if (!subId || !Number.isFinite(qty) || qty <= 0) return fail(400, { error: 'Invalid build quantity' });
		if (mode !== 'denovo' && mode !== 'stock') return fail(400, { error: 'Invalid build mode' });

		const sub = await PartDefinition.findById(subId).lean() as any;
		if (!sub?.isSubassembly) return fail(404, { error: 'Subassembly not found' });

		if (mode === 'stock') {
			// Deduct children from loose stock; refuse rather than go negative.
			const children = await PartDefinition.find({ _id: { $in: (sub.components ?? []).map((c: any) => c.partDefinitionId) } }).lean() as any[];
			const childById = new Map(children.map((c) => [c._id, c]));
			for (const c of sub.components ?? []) {
				const child = childById.get(c.partDefinitionId);
				const need = (c.quantity ?? 1) * qty;
				if (!child || (child.inventoryCount ?? 0) < need) {
					return fail(400, { error: `Not enough loose ${c.partNumber} (need ${need}, have ${child?.inventoryCount ?? 0})` });
				}
			}
			for (const c of sub.components ?? []) {
				await PartDefinition.updateOne(
					{ _id: c.partDefinitionId },
					{ $inc: { inventoryCount: -(c.quantity ?? 1) * qty } }
				);
			}
		}

		await PartDefinition.updateOne({ _id: subId }, { $inc: { inventoryCount: qty } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: subId,
			action: 'UPDATE',
			oldData: { inventoryCount: sub.inventoryCount ?? 0 },
			newData: { inventoryCount: (sub.inventoryCount ?? 0) + qty, mode, qty },
			reason: mode === 'stock' ? 'Subassembly built from stock (children deducted)' : 'Subassembly added de novo',
			changedBy: locals.user!.username ?? locals.user!._id
		});
		return { success: true, message: `${sub.partNumber}: +${qty} (${mode === 'stock' ? 'from stock' : 'de novo'})` };
	},

	unbuildSubassembly: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const subId = form.get('subId')?.toString();
		const qty = Math.floor(Number(form.get('qty')));
		const mode = form.get('mode')?.toString(); // 'return' | 'discard'
		if (!subId || !Number.isFinite(qty) || qty <= 0) return fail(400, { error: 'Invalid quantity' });
		if (mode !== 'return' && mode !== 'discard') return fail(400, { error: 'Invalid mode' });

		const sub = await PartDefinition.findById(subId).lean() as any;
		if (!sub?.isSubassembly) return fail(404, { error: 'Subassembly not found' });
		if ((sub.inventoryCount ?? 0) < qty) return fail(400, { error: `Only ${sub.inventoryCount ?? 0} on hand` });

		await PartDefinition.updateOne({ _id: subId }, { $inc: { inventoryCount: -qty } });
		if (mode === 'return') {
			for (const c of sub.components ?? []) {
				await PartDefinition.updateOne(
					{ _id: c.partDefinitionId },
					{ $inc: { inventoryCount: (c.quantity ?? 1) * qty } }
				);
			}
		}
		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: subId,
			action: 'UPDATE',
			oldData: { inventoryCount: sub.inventoryCount ?? 0 },
			newData: { inventoryCount: (sub.inventoryCount ?? 0) - qty, mode, qty },
			reason: mode === 'return' ? 'Subassembly disassembled (parts returned to stock)' : 'Subassembly removed (no return)',
			changedBy: locals.user!.username ?? locals.user!._id
		});
		return { success: true, message: `${sub.partNumber}: −${qty} (${mode === 'return' ? 'parts returned' : 'no return'})` };
	},

	createCartridgePart: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const partNumber = form.get('partNumber')?.toString().trim();
		const name = form.get('name')?.toString().trim();
		if (!partNumber || !name) return fail(400, { error: 'Part number and name are required' });

		const existing = await PartDefinition.findOne({ partNumber });
		if (existing) return fail(400, { error: 'Part number already exists' });

		const newPart = await PartDefinition.create({
			_id: generateId(),
			partNumber,
			name,
			category: form.get('category')?.toString().trim() || undefined,
			manufacturer: form.get('manufacturer')?.toString().trim() || undefined,
			supplier: form.get('supplier')?.toString().trim() || undefined,
			unitCost: form.get('unitCost')?.toString().trim() || undefined,
			quantityPerUnit: form.get('quantityPerUnit') ? Number(form.get('quantityPerUnit')) : 1,
			unitOfMeasure: form.get('unitOfMeasure')?.toString().trim() || 'ea',
			inventoryCount: form.get('inventoryCount') ? Number(form.get('inventoryCount')) : 0,
			minimumOrderQty: form.get('minimumStockLevel') ? Number(form.get('minimumStockLevel')) : 0,
			description: form.get('description')?.toString().trim() || undefined,
			bomType: 'cartridge',
			isActive: true,
			createdBy: locals.user!._id
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: newPart._id,
			action: 'INSERT',
			newData: { partNumber, name, bomType: 'cartridge' },
			changedAt: new Date(),
			changedBy: locals.user!.username
		});

		return { success: true };
	},

	deleteCartridgePart: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'Part ID required' });

		const part = await PartDefinition.findById(id).lean() as any;
		if (!part) return fail(404, { error: 'Part not found' });

		await PartDefinition.deleteOne({ _id: id });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: id,
			action: 'DELETE',
			oldData: { partNumber: part.partNumber, name: part.name, bomType: part.bomType },
			changedAt: new Date(),
			changedBy: locals.user!.username
		});

		return { success: true };
	},

	withdraw: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const form = await request.formData();
		const partId = form.get('partId')?.toString().trim();
		const qtyStr = form.get('quantity')?.toString().trim();
		const reason = form.get('reason')?.toString().trim();

		if (!partId) return fail(400, { withdrawError: 'Select a part' });
		if (!qtyStr || isNaN(Number(qtyStr)) || Number(qtyStr) <= 0) {
			return fail(400, { withdrawError: 'Enter a valid quantity greater than 0' });
		}
		if (!reason) return fail(400, { withdrawError: 'Provide a reason' });

		const quantity = Number(qtyStr);
		const part = await PartDefinition.findById(partId).lean() as any;
		if (!part) return fail(404, { withdrawError: 'Part not found' });

		const balanceAgg = await InventoryTransaction.aggregate([
			{ $match: { partDefinitionId: partId } },
			{ $group: { _id: null, total: { $sum: '$quantity' } } }
		]);
		const previousQuantity = balanceAgg[0]?.total ?? 0;
		const newQuantity = previousQuantity - quantity;

		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: partId,
			partNumber: part.partNumber,
			transactionType: 'consumption',
			quantity: -quantity,
			previousQuantity,
			newQuantity,
			reason: `Withdraw: ${reason}`,
			performedBy: locals.user!._id,
			performedAt: new Date(),
			operatorId: locals.user!._id,
			operatorUsername: locals.user!.username,
			notes: reason
		});

		await PartDefinition.updateOne(
			{ _id: partId },
			{ $inc: { inventoryCount: -quantity } }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'inventory_transactions',
			recordId: partId,
			action: 'INSERT',
			newData: { partNumber: part.partNumber, quantity: -quantity, reason },
			changedAt: new Date(),
			changedBy: locals.user!.username
		});

		return {
			withdrawSuccess: true,
			withdrawMessage: `Withdrew ${quantity} of ${part.partNumber} — ${part.name}. New stock: ${newQuantity}`
		};
	}
};

export const config = { maxDuration: 60 };
