import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB,
	PartDefinition,
	InventoryTransaction,
	AuditLog,
	generateId
} from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Physical-count inventory reconciliation.
 *
 * Sets ABSOLUTE counts (never deltas) after an operator physically counted
 * parts, optionally with per-barcode (bin label) quantities:
 *
 * POST {
 *   confirmed: true,
 *   performedBy?: string,
 *   counts: [{
 *     part: string,               // part number, name, or any of its barcodes
 *     newCount?: number,          // absolute total; may be omitted when barcodes given
 *     barcodes?: [{ barcode, quantity }],  // per-bin counts, upserted by barcode
 *     note?: string
 *   }]
 * }
 *
 * Rules:
 * - barcodes[] entries are UPSERTED into the part's barcodeCounts (existing
 *   entries for other barcodes are kept — a partial recount amends only the
 *   bins stated).
 * - newCount omitted → the new total = sum of ALL barcodeCounts after upsert.
 * - newCount given with barcodes → both applied; a mismatch between newCount
 *   and the barcode sum is reported back as a warning, newCount wins.
 * - Unknown barcodes are also registered as altBarcodes so future scans resolve.
 * - Atomic validation: if any entry fails to resolve/validate, nothing is
 *   written and per-entry errors are returned.
 * - Every change writes an immutable 'adjustment' InventoryTransaction
 *   (previous → new) and an audit-log entry.
 */

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolvePart(ref: string): Promise<any | null> {
	const lc = ref.toLowerCase();
	const byBarcode = await PartDefinition.findOne({
		$or: [{ barcode: lc }, { altBarcodes: lc }, { 'barcodeCounts.barcode': lc }],
		isActive: { $ne: false }
	}).lean();
	if (byBarcode) return byBarcode;
	const exact = new RegExp(`^${escapeRegex(ref)}$`, 'i');
	return (
		(await PartDefinition.findOne({ partNumber: exact, isActive: { $ne: false } }).lean()) ||
		(await PartDefinition.findOne({ name: exact, isActive: { $ne: false } }).lean())
	);
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json().catch(() => ({}));
	if (body.confirmed !== true) {
		return json(
			{ success: false, error: 'confirmed must be true — only call after the user approved the count list.' },
			{ status: 400 }
		);
	}
	const performedBy: string = typeof body.performedBy === 'string' ? body.performedBy : 'agent';
	const counts = Array.isArray(body.counts) ? body.counts : [];
	if (!counts.length) return json({ success: false, error: 'counts[] is required' }, { status: 400 });

	// ---- validate everything first; nothing is written on any error
	const errors: { index: number; error: string }[] = [];
	const resolved: { entry: any; part: any }[] = [];
	for (let i = 0; i < counts.length; i++) {
		const entry = counts[i];
		const ref = typeof entry?.part === 'string' ? entry.part.trim() : '';
		if (!ref) {
			errors.push({ index: i, error: 'part is required' });
			continue;
		}
		const part = await resolvePart(ref);
		if (!part) {
			errors.push({ index: i, error: `Part not found: ${ref}` });
			continue;
		}
		const hasNewCount = entry.newCount !== undefined && entry.newCount !== null;
		if (hasNewCount && (!Number.isInteger(entry.newCount) || entry.newCount < 0)) {
			errors.push({ index: i, error: `newCount must be a non-negative integer (got ${entry.newCount})` });
			continue;
		}
		const barcodes = Array.isArray(entry.barcodes) ? entry.barcodes : [];
		let badBarcode = false;
		for (const b of barcodes) {
			if (typeof b?.barcode !== 'string' || !b.barcode.trim()) {
				errors.push({ index: i, error: 'every barcodes[] entry needs a barcode string' });
				badBarcode = true;
				break;
			}
			if (!Number.isInteger(b?.quantity) || b.quantity < 0) {
				errors.push({ index: i, error: `barcode ${b.barcode}: quantity must be a non-negative integer` });
				badBarcode = true;
				break;
			}
		}
		if (badBarcode) continue;
		if (!hasNewCount && !barcodes.length) {
			errors.push({ index: i, error: 'provide newCount and/or barcodes[] quantities' });
			continue;
		}
		resolved.push({ entry, part });
	}
	if (errors.length) {
		return json({ success: false, error: 'Nothing was changed — fix the entries and retry.', errors }, { status: 400 });
	}

	// ---- apply
	const now = new Date();
	const results: any[] = [];
	for (const { entry, part } of resolved) {
		const previous = part.inventoryCount ?? 0;
		const provided: { barcode: string; quantity: number }[] = (entry.barcodes ?? []).map((b: any) => ({
			barcode: b.barcode.trim().toLowerCase(),
			quantity: b.quantity
		}));

		// Upsert per-barcode counts, keeping entries for bins not restated.
		const existing: any[] = Array.isArray(part.barcodeCounts) ? [...part.barcodeCounts] : [];
		for (const p of provided) {
			const idx = existing.findIndex((e) => e.barcode === p.barcode);
			const rec = { barcode: p.barcode, quantity: p.quantity, countedAt: now, countedBy: performedBy };
			if (idx >= 0) existing[idx] = rec;
			else existing.push(rec);
		}
		const barcodeSum = existing.reduce((s, e) => s + (e.quantity ?? 0), 0);
		const newCount: number =
			entry.newCount !== undefined && entry.newCount !== null ? entry.newCount : barcodeSum;
		const warning =
			provided.length && entry.newCount !== undefined && entry.newCount !== null && entry.newCount !== barcodeSum
				? `Stated total ${entry.newCount} != sum of barcode counts ${barcodeSum}; stated total was applied.`
				: null;

		// Register unknown labels so future scans resolve to this part.
		const known = new Set(
			[part.barcode, ...(part.altBarcodes ?? [])].filter(Boolean).map((b: string) => b.toLowerCase())
		);
		const newLabels = provided.map((p) => p.barcode).filter((b) => !known.has(b));

		const update: Record<string, unknown> = {
			inventoryCount: newCount,
			lastPhysicalCountAt: now,
			inventorySource: 'physical_count',
			...(provided.length ? { barcodeCounts: existing } : {})
		};
		await PartDefinition.updateOne(
			{ _id: part._id },
			{
				$set: update,
				...(newLabels.length ? { $addToSet: { altBarcodes: { $each: newLabels } } } : {})
			}
		);

		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: part._id,
			transactionType: 'adjustment',
			quantity: newCount - previous,
			previousQuantity: previous,
			newQuantity: newCount,
			reason: 'Physical count reconciliation',
			performedBy,
			performedAt: now,
			notes:
				(entry.note ? `${entry.note} ` : '') +
				(provided.length
					? `Per-barcode counts: ${provided.map((p) => `${p.barcode}=${p.quantity}`).join(', ')}`
					: 'Absolute count set from physical count')
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: part._id,
			action: 'manual_inventory_edit',
			oldData: { inventoryCount: previous },
			newData: { inventoryCount: newCount, barcodeCounts: provided.length ? existing : undefined },
			changedAt: now,
			changedBy: performedBy,
			reason: `Physical count via agent: ${part.partNumber}`
		});

		results.push({
			partNumber: part.partNumber,
			name: part.name,
			previousCount: previous,
			newCount,
			delta: newCount - previous,
			barcodeCounts: provided.length ? existing : (part.barcodeCounts ?? []),
			newLabelsRegistered: newLabels,
			warning
		});
	}

	return json({ success: true, data: { performedBy, applied: results } });
};
