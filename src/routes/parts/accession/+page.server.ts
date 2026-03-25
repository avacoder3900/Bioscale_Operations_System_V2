import { fail, error } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, AuditLog, ReceivingLot, InventoryTransaction, ManufacturingMaterial, ManufacturingMaterialTransaction, generateId, generateLotNumber } from '$lib/server/db';
import { generatePartBarcode } from '$lib/server/services/barcode-generator';
import QRCode from 'qrcode';
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
		.select('partNumber name category bomType inventoryCount barcode createdAt updatedAt')
		.sort({ partNumber: 1 })
		.lean() as any[];

	const registeredParts = allParts.filter((p: any) => p.barcode);

	// Generate QR code data URIs for registered parts
	const qrCodes: Record<string, string> = {};
	for (const p of registeredParts) {
		try {
			qrCodes[p._id] = await QRCode.toDataURL(p.barcode, { width: 128, margin: 1 });
		} catch {
			qrCodes[p._id] = '';
		}
	}

	const registered = registeredParts
		.map((p: any) => ({
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			category: p.category ?? null,
			bomType: p.bomType ?? null,
			inventoryCount: p.inventoryCount ?? 0,
			barcode: p.barcode,
			qrDataUrl: qrCodes[p._id] ?? ''
		}));

	const unregistered = allParts
		.filter((p: any) => !p.barcode)
		.map((p: any) => ({
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			category: p.category ?? null,
			bomType: p.bomType ?? null,
			inventoryCount: p.inventoryCount ?? 0
		}));

	return {
		registered: JSON.parse(JSON.stringify(registered)),
		unregistered: JSON.parse(JSON.stringify(unregistered)),
		counts: {
			total: allParts.length,
			registered: registered.length,
			unregistered: unregistered.length
		}
	};
};

export const actions: Actions = {
	assignBarcode: async ({ request, locals }) => {
		requireAccessionPermission(locals.user);
		try {
			await connectDB();

			const form = await request.formData();
			const partDefinitionId = form.get('partDefinitionId')?.toString();
			if (!partDefinitionId) return fail(400, { error: 'Part ID required' });

			const part = await PartDefinition.findById(partDefinitionId) as any;
			if (!part) return fail(404, { error: 'Part not found — it may have been deleted by a Box sync' });
			if (part.barcode) return fail(400, { error: 'Part already has a barcode' });

			const barcode = await generatePartBarcode();
			part.barcode = barcode;
			await part.save();

			await AuditLog.create({
				_id: generateId(),
				tableName: 'part_definitions',
				recordId: partDefinitionId,
				action: 'UPDATE',
				oldData: { barcode: null },
				newData: { barcode },
				changedAt: new Date(),
				changedBy: locals.user!.username,
				changedFields: ['barcode'],
				reason: 'Barcode assigned via Part Accession'
			});

			return { success: true, barcode, partNumber: part.partNumber };
		} catch (err: any) {
			console.error('[accession:assignBarcode]', err);
			return fail(500, { error: mapDbError(err) });
		}
	},

	assignAll: async ({ locals }) => {
		requireAccessionPermission(locals.user);
		try {
		await connectDB();

		const unregistered = await PartDefinition.find({
			isActive: true,
			$or: [{ barcode: null }, { barcode: '' }, { barcode: { $exists: false } }]
		}).sort({ partNumber: 1 }).lean() as any[];

		if (unregistered.length === 0) {
			return { assignAllSuccess: true, count: 0, assignments: [] };
		}

		const assignments: { partNumber: string; barcode: string }[] = [];
		const failures: { partNumber: string; error: string }[] = [];

		for (const part of unregistered) {
			try {
				const barcode = await generatePartBarcode();
				await PartDefinition.updateOne({ _id: part._id }, { $set: { barcode } });

				await AuditLog.create({
					_id: generateId(),
					tableName: 'part_definitions',
					recordId: part._id,
					action: 'UPDATE',
					oldData: { barcode: null },
					newData: { barcode },
					changedAt: new Date(),
					changedBy: locals.user!.username,
					changedFields: ['barcode'],
					reason: 'Bulk barcode assignment via Part Accession'
				});

				assignments.push({ partNumber: part.partNumber, barcode });
			} catch (err) {
				failures.push({
					partNumber: part.partNumber,
					error: err instanceof Error ? err.message : 'Unknown error'
				});
			}
		}

		return {
			assignAllSuccess: true,
			count: assignments.length,
			assignments,
			failures: failures.length > 0 ? failures : undefined
		};
		} catch (err: any) {
			console.error('[accession:assignAll]', err);
			return fail(500, { error: mapDbError(err) });
		}
	},

	exportLabels: async ({ request, locals }) => {
		requireAccessionPermission(locals.user);
		await connectDB();

		const form = await request.formData();
		const partIds = form.get('partIds')?.toString();
		const format = form.get('format')?.toString() ?? 'html';

		let filter: Record<string, any> = { isActive: true, barcode: { $exists: true, $nin: [null, ''] } };
		if (partIds) {
			const ids = partIds.split(',').map((s: string) => s.trim()).filter(Boolean);
			if (ids.length > 0) filter._id = { $in: ids };
		}

		const parts = await PartDefinition.find(filter)
			.select('partNumber name barcode category bomType')
			.sort({ partNumber: 1 })
			.lean() as any[];

		if (format === 'csv') {
			const header = 'Part Number,Part Name,Barcode,Category,BOM Type';
			const rows = parts.map((p: any) =>
				`"${p.partNumber ?? ''}","${(p.name ?? '').replace(/"/g, '""')}","${p.barcode ?? ''}","${p.category ?? ''}","${p.bomType ?? ''}"`
			);
			return { exportSuccess: true, csv: [header, ...rows].join('\n'), count: parts.length };
		}

		// Generate printable HTML with QR codes
		const labels: { partNumber: string; name: string; barcode: string; qr: string }[] = [];
		for (const p of parts) {
			const qr = await QRCode.toDataURL(p.barcode, { width: 150, margin: 1 });
			labels.push({ partNumber: p.partNumber ?? '', name: p.name ?? '', barcode: p.barcode, qr });
		}

		const html = `<!DOCTYPE html>
<html><head><title>Part QR Labels</title>
<style>
@media print { body { margin: 0; } .label { break-inside: avoid; } }
body { font-family: Arial, sans-serif; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 12px; }
.label { border: 1px solid #ccc; border-radius: 4px; padding: 8px; text-align: center; }
.label img { width: 100px; height: 100px; }
.label .part-number { font-size: 11px; font-weight: bold; margin-top: 4px; }
.label .part-name { font-size: 9px; color: #666; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; margin-inline: auto; }
.label .barcode-text { font-size: 10px; font-family: monospace; margin-top: 2px; }
</style></head><body>
<div class="grid">${labels.map(l => `
<div class="label">
<img src="${l.qr}" alt="${l.barcode}" />
<div class="part-number">${l.partNumber}</div>
<div class="part-name">${l.name}</div>
<div class="barcode-text">${l.barcode}</div>
</div>`).join('')}
</div></body></html>`;

		return { exportSuccess: true, html, count: parts.length };
	},

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
