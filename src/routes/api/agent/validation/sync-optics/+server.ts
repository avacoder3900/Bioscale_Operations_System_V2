import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Spu } from '$lib/server/db';
import { syncOpticsValidation } from '$lib/server/services/optics-validation-sync';
import type { RequestHandler } from './$types';

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Optics → SPU validation write-back trigger.
 * POST { spu? } — sync one SPU (udi/barcode/_id/suffix) or, omitted, every SPU
 * that has optical runs. Safe to re-run: idempotent, finalized SPUs skipped.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json().catch(() => ({}));
	let spuUdi: string | undefined;
	if (typeof body.spu === 'string' && body.spu.trim()) {
		const ref = body.spu.trim();
		const rx = new RegExp(`${escapeRegex(ref)}$`, 'i');
		const spu = (await Spu.findOne({
			$or: [{ _id: ref }, { udi: ref }, { barcode: ref }, { udi: rx }, { barcode: rx }]
		})
			.select('udi')
			.lean()) as any;
		if (!spu) return json({ success: false, error: `SPU not found: ${ref}` }, { status: 404 });
		spuUdi = spu.udi;
	}

	const result = await syncOpticsValidation(spuUdi ? { spuUdi } : undefined);
	return json({ success: true, data: { scope: spuUdi ?? 'all', ...result } });
};
