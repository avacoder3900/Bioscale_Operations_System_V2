import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssayDefinition, OpticalTestCartridge } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	// Only assays that carry a runnable BCODE program can be assigned.
	const assays = await AssayDefinition.find({ isActive: true, 'BCODE.code.0': { $exists: true } })
		.select('name skuCode duration BCODE.code')
		.sort({ name: 1 })
		.limit(500)
		.lean();

	const cartridges = await OpticalTestCartridge.find({ isActive: true })
		.select('barcode serialNumber assay status groupId bcode.code duration createdAt')
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
		cartridges: cartridges.map((c: any) => ({
			id: c._id,
			barcode: c.barcode,
			serialNumber: c.serialNumber ?? c.barcode,
			assayId: c.assay?._id ?? null,
			assayName: c.assay?.name ?? null,
			status: c.status,
			groupId: c.groupId ?? null,
			bcodeSteps: Array.isArray(c.bcode?.code) ? c.bcode.code.length : 0,
			duration: c.duration ?? null,
			createdAt: c.createdAt?.toISOString?.() ?? null
		}))
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
