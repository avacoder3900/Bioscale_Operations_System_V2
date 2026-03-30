import { redirect, fail } from '@sveltejs/kit';
import { connectDB, ReagentBatchRecord, CartridgeRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const filterParam = url.searchParams.get('status') || 'all';

	// Find completed reagent runs that have (or need) a QA/QC release
	const query: Record<string, any> = {
		status: { $in: ['Completed', 'completed', 'Storage', 'Top Sealing'] }
	};

	// Filter by test result status
	if (filterParam === 'pending') {
		query['qcRelease.testResult'] = { $in: ['pending', null, undefined] };
		query['qcRelease.createdAt'] = { $exists: true };
	} else if (filterParam === 'testing') {
		query['qcRelease.testResult'] = 'testing';
	} else if (filterParam === 'passed') {
		query['qcRelease.testResult'] = 'pass';
	} else if (filterParam === 'failed') {
		query['qcRelease.testResult'] = 'fail';
	}

	const runs = await ReagentBatchRecord.find(query)
		.sort({ createdAt: -1 })
		.limit(100)
		.lean();

	const releases = (runs as any[]).map((r) => ({
		id: String(r._id),
		shippingLotId: r.qcRelease?.shippingLotId ?? '',
		reagentRunId: String(r._id),
		qaqcCartridgeIds: r.qcRelease?.qaqcCartridgeIds ?? [],
		testResult: r.qcRelease?.testResult ?? null,
		testedBy: r.qcRelease?.testedBy?.username ?? null,
		testedAt: r.qcRelease?.testedAt ? new Date(r.qcRelease.testedAt).toISOString() : null,
		notes: r.qcRelease?.notes ?? null,
		createdAt: r.qcRelease?.createdAt
			? new Date(r.qcRelease.createdAt).toISOString()
			: r.createdAt
				? new Date(r.createdAt).toISOString()
				: ''
	}));

	return { releases, filter: filterParam };
};

export const actions: Actions = {
	/** Create a QA/QC release for a reagent run */
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const shippingLotId = (data.get('shippingLotId') as string)?.trim();
		const reagentRunId = (data.get('reagentRunId') as string)?.trim();

		if (!shippingLotId || !reagentRunId) {
			return fail(400, { error: 'Shipping Lot ID and Reagent Run ID are required' });
		}

		const run = await ReagentBatchRecord.findById(reagentRunId).lean() as any;
		if (!run) return fail(404, { error: `Run '${reagentRunId}' not found` });

		if (run.qcRelease?.createdAt) {
			return fail(400, { error: 'A QA/QC release already exists for this run' });
		}

		await ReagentBatchRecord.findByIdAndUpdate(reagentRunId, {
			$set: {
				'qcRelease.shippingLotId': shippingLotId,
				'qcRelease.testResult': 'pending',
				'qcRelease.qaqcCartridgeIds': [],
				'qcRelease.createdAt': new Date()
			}
		});

		return { success: true };
	},

	/** Start testing — assign cartridge IDs for QA/QC */
	startTesting: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const releaseId = data.get('releaseId') as string;
		const cartridgeIdsRaw = data.get('cartridgeIds') as string;

		let cartridgeIds: string[] = [];
		if (cartridgeIdsRaw) {
			try { cartridgeIds = JSON.parse(cartridgeIdsRaw); } catch { /* ignore */ }
		}

		await ReagentBatchRecord.findByIdAndUpdate(releaseId, {
			$set: {
				'qcRelease.testResult': 'testing',
				'qcRelease.qaqcCartridgeIds': cartridgeIds
			}
		});

		// Mark cartridges as being tested
		if (cartridgeIds.length > 0) {
			await CartridgeRecord.updateMany(
				{ _id: { $in: cartridgeIds } },
				{ $set: { currentPhase: 'released' } }
			);
		}

		return { success: true };
	},

	/** Record the QA/QC test result */
	recordResult: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const releaseId = data.get('releaseId') as string;
		const result = data.get('result') as string;
		const notes = (data.get('notes') as string) || undefined;

		if (!['passed', 'failed', 'pass', 'fail'].includes(result)) {
			return fail(400, { error: 'Result must be "passed" or "failed"' });
		}

		// Normalize: 'passed' → 'pass', 'failed' → 'fail'
		const normalizedResult = result === 'passed' ? 'pass' : result === 'failed' ? 'fail' : result;
		const now = new Date();

		await ReagentBatchRecord.findByIdAndUpdate(releaseId, {
			$set: {
				'qcRelease.testResult': normalizedResult,
				'qcRelease.testedBy': { _id: locals.user._id, username: locals.user.username },
				'qcRelease.testedAt': now,
				'qcRelease.notes': notes
			}
		});

		// Write qaqcRelease phase to CartridgeRecord for sample cartridges
		const run = await ReagentBatchRecord.findById(releaseId, { qcRelease: 1 }).lean() as any;
		const sampleIds = run?.qcRelease?.qaqcCartridgeIds ?? [];
		const shippingLotId = run?.qcRelease?.shippingLotId;

		if (sampleIds.length > 0) {
			const bulkOps = sampleIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'qaqcRelease.recordedAt': { $exists: false } },
					update: {
						$set: {
							'qaqcRelease.shippingLotId': shippingLotId,
							'qaqcRelease.testResult': normalizedResult,
							'qaqcRelease.testedBy': { _id: locals.user._id, username: locals.user.username },
							'qaqcRelease.testedAt': now,
							'qaqcRelease.notes': notes,
							'qaqcRelease.recordedAt': now,
							currentPhase: normalizedResult === 'pass' ? 'released' : 'voided'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);
		}

		return { success: true };
	}
};
