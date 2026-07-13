import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, Batch, User, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Scan/lookup must resolve against the whole DB, not just the loaded page,
	// otherwise a scan of an SPU on another page falsely offers to register it.
	const lookupTerm = url.searchParams.get('lookup')?.trim();
	let lookupNotFound: string | null = null;
	if (lookupTerm) {
		const esc = escapeRegex(lookupTerm);
		// Mirror handleLookup's client-side matching: exact (case-insensitive)
		// UDI or barcode, plus the extractShortId-derived forms of the UDI.
		const or: any[] = [
			{ udi: { $regex: `^${esc}$`, $options: 'i' } },
			{ barcode: { $regex: `^${esc}$`, $options: 'i' } }
		];
		const shortMatch = lookupTerm.match(/^SPU-(.+)$/i);
		if (shortMatch) {
			// "SPU-XXXXXXXX" comes from the first chars of the UDI's (21) segment.
			or.push({ udi: { $regex: `\\(21\\)${escapeRegex(shortMatch[1])}`, $options: 'i' } });
		} else if (lookupTerm.length === 8) {
			// Fallback shortId form: first 8 chars of a UDI without a (21) segment.
			or.push({ udi: { $regex: `^${esc}`, $options: 'i' } });
		}

		const hit = await Spu.findOne({ $or: or }).select('_id').lean();
		if (hit) {
			throw redirect(303, `/spu/${(hit as any)._id}`);
		}
		lookupNotFound = lookupTerm;
	}

	const pageSize = 50;
	const pageNum = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);

	const [totalCount, spus, batches] = await Promise.all([
		Spu.countDocuments({}),
		Spu.find()
			.select('udi barcode status deviceState owner batch.batchNumber qcStatus validation.status createdAt createdBy')
			.sort({ createdAt: -1 })
			.skip((pageNum - 1) * pageSize)
			.limit(pageSize)
			.lean(),
		Batch.find().select('batchNumber').sort({ batchNumber: 1 }).lean()
	]);

	// Resolve createdBy usernames
	const userIds = [...new Set(spus.map((s: any) => s.createdBy).filter(Boolean))];
	const users = userIds.length
		? await User.find({ _id: { $in: userIds } }, { username: 1 }).lean()
		: [];
	const userMap = new Map(users.map((u: any) => [u._id, u.username]));

	return {
		spus: spus.map((s: any) => ({
			id: s._id,
			udi: s.udi,
			barcode: s.barcode ?? null,
			status: s.status ?? 'draft',
			deviceState: s.deviceState ?? '',
			owner: s.owner ?? null,
			batchNumber: s.batch?.batchNumber ?? null,
			qcStatus: s.qcStatus ?? 'pending',
			validationStatus: s.validation?.status ?? 'pending',
			createdAt: s.createdAt,
			createdByUsername: userMap.get(s.createdBy) ?? null
		})),
		batches: batches.map((b: any) => ({ id: b._id, batchNumber: b.batchNumber ?? '' })),
		fieldHints: { batchRecommended: true, ownerRecommended: false },
		page: pageNum,
		pageSize,
		totalCount,
		lookupNotFound
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const serialNumber = form.get('serialNumber')?.toString().trim();
		if (!serialNumber) return fail(400, { error: 'Serial number is required' });

		const udi = `SPU-${serialNumber}`;
		const existing = await Spu.findOne({ udi });
		if (existing) return fail(400, { error: 'UDI already exists' });

		const batchId = form.get('batchId')?.toString() || undefined;
		let batchRef;
		if (batchId) {
			const batch = await Batch.findById(batchId).lean();
			if (batch) batchRef = { _id: (batch as any)._id, batchNumber: (batch as any).batchNumber };
		}

		const barcode = form.get('barcode')?.toString().trim() || undefined;
		await Spu.create({
			_id: generateId(),
			udi,
			barcode,
			status: 'draft',
			assemblyStatus: 'created',
			qcStatus: 'pending',
			batch: batchRef,
			createdBy: locals.user!._id
		});

		return { success: true };
	},

	register: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const udi = form.get('udi')?.toString().trim();
		if (!udi) return fail(400, { error: 'UDI is required' });

		const existing = await Spu.findOne({ udi });
		if (existing) return fail(400, { error: 'UDI already exists' });

		const batchId = form.get('batchId')?.toString() || undefined;
		let batchRef;
		if (batchId) {
			const batch = await Batch.findById(batchId).lean();
			if (batch) batchRef = { _id: (batch as any)._id, batchNumber: (batch as any).batchNumber };
		}

		const spuId = generateId();
		const barcode = form.get('barcode')?.toString().trim() || undefined;
		await Spu.create({
			_id: spuId,
			udi,
			barcode,
			status: 'draft',
			deviceState: form.get('deviceState')?.toString() || undefined,
			owner: form.get('owner')?.toString() || undefined,
			ownerNotes: form.get('ownerNotes')?.toString() || undefined,
			assemblyStatus: 'created',
			qcStatus: 'pending',
			batch: batchRef,
			createdBy: locals.user!._id
		});

		return { success: true, spuId };
	}
};
