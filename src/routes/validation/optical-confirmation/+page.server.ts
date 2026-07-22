import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssayDefinition, CartridgeRecord } from '$lib/server/db';
import { computeOpticalAnalysis } from '$lib/server/optical-analysis';
import type { Actions, PageServerLoad } from './$types';

// The single optical-confirmation assay in use: "Gen 5 Optical Scan - Start
// Position Corrected". Change this id if a different optical assay is adopted.
const OPTICAL_ASSAY_ID = 'A9EB41AD';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	// Only the one optical assay we run.
	const assays = await AssayDefinition.find({ _id: OPTICAL_ASSAY_ID })
		.select('name skuCode duration BCODE.code')
		.lean();

	// Optical test cartridge log — read run status from cartridge_records (where the
	// device/brevitest-cloud writes the run lifecycle: linked -> underway -> completed).
	const cartridges = await CartridgeRecord.find({ assayCategory: 'optical_test' })
		.select('serialNumber assayId assayName status statusUpdatedOn checkpoints createdAt analysis rawData device')
		.sort({ createdAt: -1 })
		.limit(200)
		.lean();

	return {
		assays: assays.map((a: any) => ({
			id: a._id,
			name: a.name,
			skuCode: a.skuCode ?? a._id,
			duration: a.duration ?? null,
			bcodeSteps: Array.isArray(a.BCODE?.code) ? a.BCODE.code.length : 0
		})),
		cartridges: cartridges.map((c: any) => {
			// VALIDATION-04: per-channel F7/F3 from rawData.readings (already
			// selected above; previously loaded and thrown away).
			const analysis = computeOpticalAnalysis(c);
			return {
				id: c._id,
				barcode: c._id, // cartridge_records _id IS the scanned barcode
				assayName: c.assayName ?? c.assayId ?? null,
				status: c.status ?? 'linked',
				ran: !!(c.checkpoints?.completed || c.checkpoints?.underway || c.status === 'completed'),
				// The run writes a `device` block — its name is the SPU/reader it ran on.
				spuUdi: c.device?.name ?? null,
				spuDeviceId: c.device?.id ?? null,
				assignedAt: c.createdAt?.toISOString?.() ?? null,
				underwayAt: c.checkpoints?.underway?.when ?? null,
				completedAt: c.checkpoints?.completed?.when ?? null,
				analysis: analysis
					? {
						ratioByChannel: analysis.ratioByChannel,
						readingCount: analysis.readingCount,
						scanGroup: analysis.scanGroup
					}
					: null,
				result: c.analysis
					? { profileName: c.analysis.profileName ?? null, computedAt: c.analysis.computedAt ?? null }
					: null
			};
		})
	};
};

export const actions: Actions = {
	// Assign an assay as N optical-confirmation validation cartridges. Delegates to
	// the canonical API so the page and any device/scanner share one code path.
	assign: async ({ request, locals, fetch }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const assayId = form.get('assayId')?.toString().trim();
		const countRaw = form.get('count')?.toString().trim();
		const barcodesRaw = form.get('barcodes')?.toString().trim();
		const groupName = form.get('groupName')?.toString().trim() || undefined;

		if (!assayId) return fail(400, { error: 'Select an assay' });

		const barcodes = barcodesRaw
			? barcodesRaw.split(/[\s,]+/).map((b) => b.trim()).filter(Boolean)
			: undefined;
		const count = !barcodes && countRaw ? Number(countRaw) : undefined;

		if (!barcodes && (!count || count < 1)) {
			return fail(400, { error: 'Enter a count or scan/paste barcodes' });
		}

		const res = await fetch('/api/validation/optical-confirmation/assign', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ assayId, count, barcodes, groupName })
		});
		const data = await res.json();
		if (!res.ok || !data.success) return fail(res.status === 200 ? 400 : res.status, { error: data.error ?? 'Assign failed' });

		return {
			success: true,
			createdCount: data.createdCount,
			skipped: data.skipped ?? [],
			bcodeSteps: data.bcodeSteps,
			assayName: data.assay?.name ?? assayId
		};
	}
};
