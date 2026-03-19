import { redirect, fail } from '@sveltejs/kit';
import bcrypt from 'bcryptjs';
import { connectDB, ReagentBatchRecord, CartridgeRecord, User, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';

const SCRAP_CATEGORIES = ['dimensional', 'contamination', 'seal_failure', 'wax_defect', 'reagent_defect', 'other'] as const;

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
		requirePermission(locals.user, 'manufacturing:read');
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
		requirePermission(locals.user, 'manufacturing:read');
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
		requirePermission(locals.user, 'manufacturing:read');
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

			// Record QA/QC transactions
			for (const cid of sampleIds) {
				if (normalizedResult === 'fail') {
					await recordTransaction({
						transactionType: 'scrap',
						cartridgeRecordId: cid,
						quantity: 1,
						manufacturingStep: 'qa_qc',
						manufacturingRunId: releaseId,
						operatorId: locals.user._id,
						operatorUsername: locals.user.username,
						notes: `QA/QC failed${notes ? `: ${notes}` : ''}`
					});
				} else {
					await recordTransaction({
						transactionType: 'creation',
						cartridgeRecordId: cid,
						quantity: 1,
						manufacturingStep: 'qa_qc',
						manufacturingRunId: releaseId,
						operatorId: locals.user._id,
						operatorUsername: locals.user.username,
						notes: `QA/QC passed — released (lot ${shippingLotId ?? 'unknown'})`
					});
				}
			}
		}

		return { success: true };
	},

	/** Scrap a cartridge that fails QC */
	scrapCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:read');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = (data.get('cartridgeId') as string)?.trim();
		const scrapCategory = data.get('scrapCategory') as string;
		const notes = (data.get('notes') as string) || undefined;
		const photoUrl = (data.get('photoUrl') as string) || undefined;

		if (!cartridgeId) return fail(400, { error: 'Cartridge ID is required' });
		if (!scrapCategory || !SCRAP_CATEGORIES.includes(scrapCategory as any)) {
			return fail(400, { error: 'Valid scrap reason category is required' });
		}

		const cartridge = await CartridgeRecord.findById(cartridgeId).lean() as any;
		if (!cartridge) return fail(404, { error: 'Cartridge not found' });
		if (cartridge.currentPhase === 'voided') {
			return fail(400, { error: 'Cartridge is already scrapped/voided' });
		}

		const now = new Date();

		// Mark cartridge as scrapped (voided)
		await CartridgeRecord.findByIdAndUpdate(cartridgeId, {
			$set: {
				currentPhase: 'voided',
				voidedAt: now,
				voidReason: `Scrapped: ${scrapCategory}${notes ? ` — ${notes}` : ''}`
			}
		});

		// Record scrap transaction
		await recordTransaction({
			transactionType: 'scrap',
			cartridgeRecordId: cartridgeId,
			quantity: 1,
			manufacturingStep: 'scrap',
			operatorId: locals.user._id,
			operatorUsername: locals.user.username,
			scrapReason: notes ?? scrapCategory,
			scrapCategory: scrapCategory as any,
			photoUrl,
			notes: `QC scrap: ${scrapCategory}${notes ? ` — ${notes}` : ''}`
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cartridgeId,
			action: 'UPDATE',
			oldData: { currentPhase: cartridge.currentPhase },
			newData: { currentPhase: 'voided', voidReason: `Scrapped: ${scrapCategory}` },
			changedAt: now,
			changedBy: locals.user._id,
			reason: `QC scrap: ${scrapCategory}`
		});

		return { success: true };
	},

	/** Admin override to overturn a scrap decision */
	overturnScrap: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:read');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = (data.get('cartridgeId') as string)?.trim();
		const adminPassword = (data.get('adminPassword') as string) || '';
		const reason = (data.get('reason') as string)?.trim();

		if (!cartridgeId) return fail(400, { error: 'Cartridge ID is required' });
		if (!adminPassword) return fail(400, { error: 'Admin password is required' });
		if (!reason) return fail(400, { error: 'Reason for overturning scrap is required' });

		// Verify admin password
		const adminUser = await User.findById(locals.user._id).lean() as any;
		if (!adminUser?.passwordHash) {
			return fail(403, { error: 'Unable to verify credentials' });
		}
		const validPassword = await bcrypt.compare(adminPassword, adminUser.passwordHash);
		if (!validPassword) {
			return fail(403, { error: 'Invalid admin password' });
		}

		const cartridge = await CartridgeRecord.findById(cartridgeId).lean() as any;
		if (!cartridge) return fail(404, { error: 'Cartridge not found' });
		if (cartridge.currentPhase !== 'voided') {
			return fail(400, { error: 'Cartridge is not in scrapped/voided state' });
		}

		const now = new Date();

		// Determine the previous phase before scrap (best effort from cartridge data)
		let restoredPhase = 'stored';
		if (cartridge.storage?.recordedAt) restoredPhase = 'stored';
		else if (cartridge.topSeal?.recordedAt) restoredPhase = 'sealed';
		else if (cartridge.reagentFilling?.recordedAt) restoredPhase = 'reagent_filled';
		else if (cartridge.waxFilling?.recordedAt) restoredPhase = 'wax_filled';

		// Restore cartridge
		await CartridgeRecord.findByIdAndUpdate(cartridgeId, {
			$set: { currentPhase: restoredPhase },
			$unset: { voidedAt: '', voidReason: '' }
		});

		// Record adjustment transaction
		await recordTransaction({
			transactionType: 'adjustment',
			cartridgeRecordId: cartridgeId,
			quantity: 1,
			manufacturingStep: 'qa_qc',
			operatorId: locals.user._id,
			operatorUsername: locals.user.username,
			notes: `Scrap overturned by admin: ${reason}`
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cartridgeId,
			action: 'UPDATE',
			oldData: { currentPhase: 'voided' },
			newData: { currentPhase: restoredPhase },
			changedAt: now,
			changedBy: locals.user._id,
			reason: `Admin override: scrap overturned — ${reason}`
		});

		return { success: true, restoredPhase };
	}
};

export const config = { maxDuration: 60 };
