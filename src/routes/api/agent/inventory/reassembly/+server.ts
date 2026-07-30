import { json, error } from '@sveltejs/kit';
import { connectDB, PartDefinition, Spu, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import type { RequestHandler } from './$types';

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface PartUsageInput {
	part: string;
	quantity: number;
	note?: string;
}

interface SpuUsageInput {
	spu: string;
	parts: PartUsageInput[];
}

async function resolveSpu(ref: string): Promise<any | { ambiguous: any[] } | null> {
	const exact = await Spu.findOne({ $or: [{ _id: ref }, { udi: ref }, { barcode: ref }] })
		.select('_id udi barcode status')
		.lean();
	if (exact) return exact;

	// Suffix match so operators can say "SPU 203" or the last-5 of a barcode
	const suffix = new RegExp(`${escapeRegex(ref)}$`, 'i');
	const matches = await Spu.find({ $or: [{ udi: suffix }, { barcode: suffix }] })
		.select('_id udi barcode status')
		.limit(5)
		.lean();
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) return { ambiguous: matches };
	return null;
}

async function resolvePart(ref: string): Promise<any | null> {
	const byBarcode = await PartDefinition.findOne({ barcode: ref, isActive: { $ne: false } }).lean();
	if (byBarcode) return byBarcode;
	const exact = new RegExp(`^${escapeRegex(ref)}$`, 'i');
	return (
		(await PartDefinition.findOne({ partNumber: exact, isActive: { $ne: false } }).lean()) ||
		(await PartDefinition.findOne({ name: exact, isActive: { $ne: false } }).lean())
	);
}

/**
 * Apply reassembly part-usage inventory deductions, grouped per SPU.
 *
 * The request is validated in full before anything is applied: every SPU and
 * part reference must resolve and every quantity must be a positive integer,
 * otherwise the whole request is rejected with per-entry errors and no
 * inventory is touched. `confirmed: true` is the caller's assertion that a
 * human reviewed the part+quantity list and approved it.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { confirmed, performedBy, spus } = body as {
		confirmed?: boolean;
		performedBy?: string;
		spus?: SpuUsageInput[];
	};

	if (confirmed !== true) {
		throw error(400, 'confirmed must be true — present the full part+quantity list to the user and get approval first');
	}
	if (!Array.isArray(spus) || spus.length === 0) throw error(400, 'spus is required and must be a non-empty array');

	// ---- validation pass: resolve everything before touching inventory ----
	const problems: string[] = [];
	const resolved: { spu: any; parts: { def: any; quantity: number; note?: string }[] }[] = [];

	for (const entry of spus) {
		if (!entry?.spu || !Array.isArray(entry.parts) || entry.parts.length === 0) {
			problems.push(`Each entry needs an "spu" reference and a non-empty "parts" array (got: ${JSON.stringify(entry?.spu)})`);
			continue;
		}
		const spu = await resolveSpu(String(entry.spu).trim());
		if (!spu) {
			problems.push(`SPU not found: "${entry.spu}"`);
			continue;
		}
		if ('ambiguous' in spu) {
			const opts = spu.ambiguous.map((s: any) => s.barcode || s.udi).join(', ');
			problems.push(`SPU reference "${entry.spu}" is ambiguous — matches: ${opts}`);
			continue;
		}

		const partList: { def: any; quantity: number; note?: string }[] = [];
		for (const p of entry.parts) {
			const qty = Number(p?.quantity);
			if (!p?.part || !Number.isInteger(qty) || qty <= 0) {
				problems.push(`SPU "${entry.spu}": each part needs a "part" reference and a positive integer quantity (got part=${JSON.stringify(p?.part)}, quantity=${JSON.stringify(p?.quantity)})`);
				continue;
			}
			const def = await resolvePart(String(p.part).trim());
			if (!def) {
				problems.push(`SPU "${entry.spu}": part not found: "${p.part}" (try the parts lookup to resolve it first)`);
				continue;
			}
			partList.push({ def, quantity: qty, note: p.note });
		}
		resolved.push({ spu, parts: partList });
	}

	if (problems.length > 0) {
		return json({ success: false, applied: false, errors: problems }, { status: 400 });
	}

	// ---- apply pass ----
	const now = new Date();
	const results = [];
	for (const { spu, parts } of resolved) {
		const spuLabel = spu.barcode || spu.udi;
		const lines = [];
		for (const { def, quantity, note } of parts) {
			const txId = await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: String(def._id),
				spuId: String(spu._id),
				quantity,
				operatorUsername: performedBy,
				notes: note
					? `Reassembly of SPU ${spuLabel}: ${note}`
					: `Reassembly of SPU ${spuLabel}`
			});
			const after = (await PartDefinition.findById(def._id).select('inventoryCount').lean()) as any;
			lines.push({
				transactionId: txId,
				partNumber: def.partNumber,
				name: def.name,
				quantityUsed: quantity,
				previousCount: (after?.inventoryCount ?? 0) + quantity,
				newCount: after?.inventoryCount ?? 0,
				unitOfMeasure: def.unitOfMeasure
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'inventory_transactions',
			recordId: String(spu._id),
			action: 'INSERT',
			newData: {
				operation: 'reassembly_parts_usage',
				spu: spuLabel,
				parts: lines.map((l) => ({ partNumber: l.partNumber, quantity: l.quantityUsed }))
			},
			changedBy: performedBy || 'agent',
			changedAt: now
		});

		results.push({
			spuId: String(spu._id),
			spuBarcode: spu.barcode ?? null,
			spuUdi: spu.udi,
			spuShortRef: String(spuLabel).slice(-5),
			parts: lines
		});
	}

	return json({ success: true, applied: true, data: { spus: results } }, { status: 201 });
};
