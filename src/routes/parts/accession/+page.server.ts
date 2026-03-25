import { fail, error } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, AuditLog, ReceivingLot, InventoryTransaction, ManufacturingMaterial, ManufacturingMaterialTransaction, generateId, generateLotNumber } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

function requireAccessionPermission(user: any): void {
	if (!hasPermission(user, 'inventory:write') && !hasPermission(user, 'inventory:read') && !hasPermission(user, 'admin:full')) {
		throw error(403, 'Permission denied: requires inventory:read, inventory:write, or admin:full');
	}
}

function mapDbError(err: any): string {
	if (err?.code === 11000) return 'This barcode is already registered';
	if (err?.name === 'MongoNetworkError' || err?.name === 'MongoServerSelectionError') return 'Database connection error — please retry';
	if (err?.name === 'MongoTimeoutError') return 'Database connection error — please retry';
	return err?.message ?? 'An unexpected error occurred';
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAccessionPermission(locals.user);
	await connectDB();

	const allParts = await PartDefinition.find({ isActive: true })
		.select('partNumber name barcode')
		.sort({ partNumber: 1 })
		.lean() as any[];

	const registered = allParts
		.filter((p: any) => p.barcode)
		.map((p: any) => ({ id: p._id, partNumber: p.partNumber ?? '', name: p.name ?? '' }));

	const unregistered = allParts
		.filter((p: any) => !p.barcode)
		.map((p: any) => ({ id: p._id, partNumber: p.partNumber ?? '', name: p.name ?? '' }));

	return {
		registered: JSON.parse(JSON.stringify(registered)),
		unregistered: JSON.parse(JSON.stringify(unregistered))
	};
};

export const actions: Actions = {
	registerBarcode: async ({ request, locals }) => {
		requireAccessionPermission(locals.user);
		await connectDB();

		const form = await request.formData();
		const partId = form.get('partId')?.toString();
		const barcode = form.get('barcode')?.toString()?.trim();

		if (!partId) return fail(400, { registerError: 'Part is required' });
		if (!barcode) return fail(400, { registerError: 'Barcode is required' });

		const part = await PartDefinition.findById(partId).lean() as any;
		if (!part) return fail(404, { registerError: 'Part not found' });

		// Check uniqueness — no other part should have this barcode
		const existing = await PartDefinition.findOne({ barcode, _id: { $ne: partId } }).lean() as any;
		if (existing) {
			return fail(400, { registerError: `Barcode "${barcode}" is already assigned to ${existing.partNumber} (${existing.name})` });
		}

		const oldBarcode = part.barcode || null;
		await PartDefinition.updateOne({ _id: partId }, { $set: { barcode } });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: partId,
			action: 'UPDATE',
			oldData: { barcode: oldBarcode },
			newData: { barcode },
			changedAt: new Date(),
			changedBy: locals.user!.username,
			changedFields: ['barcode'],
			reason: oldBarcode
				? 'Manual barcode re-registration via Part Accession'
				: 'Manual barcode registration via Part Accession'
		});

		return {
			registerSuccess: true,
			registeredPartNumber: part.partNumber,
			registeredPartName: part.name,
			registeredBarcode: barcode,
			registeredPartId: partId,
			wasOverwrite: !!oldBarcode,
			oldBarcode
		};
	},

	quickScan: async ({ request, locals }) => {
		requireAccessionPermission(locals.user);
		try {
		await connectDB();

		const form = await request.formData();
		const partId = form.get('partId')?.toString();
		const bagBarcode = form.get('bagBarcode')?.toString();
		const quantityStr = form.get('quantity')?.toString();
		const notes = form.get('notes')?.toString() || 'Bulk accession - existing inventory';

		if (!partId) return fail(400, { error: 'Part is required' });
		if (!bagBarcode) return fail(400, { error: 'Bag barcode is required' });
		if (!quantityStr) return fail(400, { error: 'Quantity is required' });

		const quantity = parseInt(quantityStr, 10);
		if (isNaN(quantity) || quantity <= 0) return fail(400, { error: 'Quantity must be a positive number' });

		// Check for duplicate barcode
		const existing = await ReceivingLot.findOne({ lotId: bagBarcode }).lean();
		if (existing) return fail(400, { error: `Barcode "${bagBarcode}" is already registered as a lot` });

		// Look up part
		const part = await PartDefinition.findById(partId).lean() as any;
		if (!part) return fail(404, { error: 'Part not found — it may have been deleted by a Box sync' });

		const lotNumber = await generateLotNumber(ReceivingLot);

		// Create ReceivingLot
		let lot: any;
		try {
			lot = await ReceivingLot.create({
				_id: generateId(),
				lotId: bagBarcode,
				lotNumber,
				part: { _id: part._id, partNumber: part.partNumber, name: part.name },
				quantity,
				operator: { _id: locals.user!._id, username: locals.user!.username },
				inspectionPathway: 'coc',
				cocMeetsStandards: true,
				status: 'accepted',
				notes,
				bagBarcode,
				createdAt: new Date()
			});
		} catch (err: any) {
			if (err?.code === 11000) {
				const existingLot = await ReceivingLot.findOne({ lotId: bagBarcode }).lean() as any;
				const lotRef = existingLot?.lotNumber ? `Lot #${existingLot.lotNumber}` : 'an existing lot';
				return fail(400, { error: `This barcode is already registered as ${lotRef}` });
			}
			throw err;
		}

		// Update inventory count
		const prevCount = part.inventoryCount ?? 0;
		const newCount = prevCount + quantity;
		await PartDefinition.updateOne({ _id: partId }, { $inc: { inventoryCount: quantity } });

		// Create InventoryTransaction
		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: partId,
			transactionType: 'receipt',
			quantity,
			previousQuantity: prevCount,
			newQuantity: newCount,
			reason: `Quick scan accession lot ${lotNumber}`,
			performedBy: locals.user!._id,
			performedAt: new Date()
		});

		// Sync ManufacturingMaterial if linked
		const mfgMaterial = await ManufacturingMaterial.findOne({ partDefinitionId: partId }).lean() as any;
		if (mfgMaterial) {
			const mfgBefore = mfgMaterial.currentQuantity ?? 0;
			const mfgAfter = mfgBefore + quantity;
			const now = new Date();

			await ManufacturingMaterialTransaction.create({
				_id: generateId(),
				materialId: mfgMaterial._id,
				transactionType: 'receive',
				quantityChanged: quantity,
				quantityBefore: mfgBefore,
				quantityAfter: mfgAfter,
				operatorId: locals.user!._id,
				notes: `Received via quick scan lot ${lotNumber}`,
				createdAt: now
			});

			await ManufacturingMaterial.findByIdAndUpdate(mfgMaterial._id, {
				$set: { currentQuantity: mfgAfter, updatedAt: now },
				$push: {
					recentTransactions: {
						$each: [{
							transactionType: 'receive',
							quantityChanged: quantity,
							quantityBefore: mfgBefore,
							quantityAfter: mfgAfter,
							operatorId: locals.user!._id,
							notes: `Received via quick scan lot ${lotNumber}`,
							createdAt: now
						}],
						$slice: -100
					}
				}
			});
		}

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'receiving_lot',
			recordId: lot._id,
			action: 'INSERT',
			oldData: null,
			newData: { lotId: bagBarcode, lotNumber, partNumber: part.partNumber, quantity, status: 'accepted' },
			changedAt: new Date(),
			changedBy: locals.user!.username,
			reason: 'Quick scan accession - bulk inventory'
		});

		return { quickScanSuccess: true, lotNumber, bagBarcode, partNumber: part.partNumber, quantity };
		} catch (err: any) {
			console.error('[accession:quickScan]', err);
			return fail(500, { error: mapDbError(err) });
		}
	}
};
