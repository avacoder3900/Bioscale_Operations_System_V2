import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, LaserCutBatch, ManufacturingSettings, ManufacturingMaterial,
	ManufacturingMaterialTransaction, AuditLog, generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { nanoid } from 'nanoid';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [batches, settingsDoc, materials] = await Promise.all([
		LaserCutBatch.find().sort({ createdAt: -1 }).limit(50).lean(),
		ManufacturingSettings.findById('default').lean(),
		ManufacturingMaterial.find().lean()
	]);

	const general = (settingsDoc as any)?.general ?? {};

	// FIX-01: Find the laser-cut output material (cut substrates) by name convention
	const outputMaterial = (materials as any[]).find((m: any) =>
		m.name && /laser.?cut|cut.?sub|substrate/i.test(m.name)
	) ?? null;

	// Stats rollup
	const totalBatches = batches.length;
	const totalInput = batches.reduce((s: number, b: any) => s + (b.inputSheetCount ?? 0), 0);
	const totalOutput = batches.reduce((s: number, b: any) => s + (b.outputSheetCount ?? 0), 0);
	const totalFailures = batches.reduce((s: number, b: any) => s + (b.failureCount ?? 0), 0);
	const failureRate = totalInput > 0 ? totalFailures / totalInput : 0;

	return {
		batches: (batches as any[]).map((b: any) => ({
			batchId: b._id,
			inputSheetCount: b.inputSheetCount ?? 0,
			outputSheetCount: b.outputSheetCount ?? 0,
			failureCount: b.failureCount ?? 0,
			failureNotes: b.failureNotes ?? null,
			cuttingProgramLink: b.cuttingProgramLink ?? null,
			toolsUsed: b.toolsUsed ?? null,
			operatorId: b.operatorId ?? null,
			operatorName: b.operatorId ?? null,
			inputLotId: b.inputLotId ?? null,
			outputLotId: b.outputLotId ?? null,
			operator: b.operator ?? null,
			createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt ?? '')
		})),
		stats: { totalBatches, totalInput, totalOutput, totalFailures, failureRate },
		defaults: {
			defaultLaserTools: general.defaultLaserTools ?? null,
			defaultCuttingProgramLink: general.defaultCuttingProgramLink ?? null
		},
		inventory: {
			laserCutSheets: {
				name: outputMaterial?.name ?? 'Laser Cut Substrates',
				quantity: outputMaterial?.currentQuantity ?? 0,
				unit: outputMaterial?.unit ?? 'sheets'
			}
		}
	};
};

export const actions: Actions = {
	/** Record a completed laser-cut batch and update inventory */
	recordBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const inputSheetCount = Number(data.get('inputSheetCount') || 0);
		const failureCount = Number(data.get('failureCount') || 0);
		const outputSheetCount = Math.max(0, inputSheetCount - failureCount);
		const failureNotes = (data.get('failureNotes') as string) || undefined;
		const cuttingProgramLink = (data.get('cuttingProgramLink') as string) || undefined;
		const toolsUsed = (data.get('toolsUsed') as string) || undefined;
		const inputLotId = (data.get('inputLotId') as string) || undefined;

		if (inputSheetCount <= 0) return fail(400, { error: 'Input sheet count must be > 0' });

		// FIX-01: Find linked parts from ManufacturingSettings (optional)
		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const general = settingsDoc?.general ?? {};

		// Generate output lot number: LOT-YYYYMMDD-XXXX
		const now2 = new Date();
		const dateStr = `${now2.getFullYear()}${String(now2.getMonth() + 1).padStart(2, '0')}${String(now2.getDate()).padStart(2, '0')}`;
		const outputLotId = `LOT-${dateStr}-${nanoid(4).toUpperCase()}`;

		// Create the batch record
		await LaserCutBatch.create({
			_id: generateId(),
			inputSheetCount,
			outputSheetCount,
			failureCount,
			failureNotes,
			cuttingProgramLink: cuttingProgramLink || general.defaultCuttingProgramLink || undefined,
			toolsUsed: toolsUsed || general.defaultLaserTools || undefined,
			operatorId: locals.user._id,
			inputLotId,
			outputLotId,
			operator: { _id: locals.user._id, username: locals.user.username }
		});

		// FIX-01: Update inventory for output substrates produced
		if (outputSheetCount > 0) {
			const outputMaterial = await ManufacturingMaterial.findOne({
				name: { $regex: /laser.?cut|cut.?sub|substrate/i }
			}).lean() as any;

			if (outputMaterial) {
				const quantityBefore = outputMaterial.currentQuantity ?? 0;
				const quantityAfter = quantityBefore + outputSheetCount;
				const now = new Date();

				await ManufacturingMaterialTransaction.create({
					_id: generateId(),
					materialId: outputMaterial._id,
					transactionType: 'produce',
					quantityChanged: outputSheetCount,
					quantityBefore,
					quantityAfter,
					operatorId: locals.user._id,
					notes: `Laser cut batch produced ${outputSheetCount} sheets (${failureCount} failures from ${inputSheetCount} input)`,
					createdAt: now
				});

				const txEntry = {
					transactionType: 'produce',
					quantityChanged: outputSheetCount,
					quantityBefore,
					quantityAfter,
					operatorId: locals.user._id,
					notes: `Laser cut batch: ${outputSheetCount} output`,
					createdAt: now
				};

				await ManufacturingMaterial.findByIdAndUpdate(outputMaterial._id, {
					$set: { currentQuantity: quantityAfter, updatedAt: now },
					$push: { recentTransactions: { $each: [txEntry], $slice: -100 } }
				});
			}
		}

		// Part-level inventory transactions — wire both legs to PartDefinition
		// so WI-01 and the Parts page see the same number.
		//
		//   PT-CT-111 Thermoseal Cut Sheet      — consumed by inputSheetCount
		//   PT-CT-112 Thermoseal Laser Cut Sht  — created by outputSheetCount × cartridgesPerLaserCutSheet (counted in strips)
		//
		// Previously this block just called recordTransaction with no
		// partDefinitionId, which wrote an orphan transaction row and did not
		// move any part's inventoryCount. The ManufacturingMaterial branch
		// above (outputMaterial) is legacy/unused — kept for now in case it's
		// referenced elsewhere, but PT-CT-112 is the source of truth.
		const stripsPerSheet: number = general.cartridgesPerLaserCutSheet ?? 6;
		const inputPartId = await resolvePartId('PT-CT-111');
		const outputPartId = await resolvePartId('PT-CT-112');

		if (inputPartId && inputSheetCount > 0) {
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: inputPartId,
				quantity: inputSheetCount,
				manufacturingStep: 'laser_cut',
				manufacturingRunId: outputLotId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				lotId: inputLotId || undefined,
				notes: `Laser cut batch ${outputLotId}: consumed ${inputSheetCount} cut sheets`
			});
		}

		if (outputPartId && outputSheetCount > 0) {
			const stripsProduced = outputSheetCount * stripsPerSheet;
			await recordTransaction({
				transactionType: 'creation',
				partDefinitionId: outputPartId,
				quantity: stripsProduced,
				manufacturingStep: 'laser_cut',
				manufacturingRunId: outputLotId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				lotId: outputLotId,
				notes: `Laser cut batch ${outputLotId}: produced ${outputSheetCount} sheets × ${stripsPerSheet} strips/sheet = ${stripsProduced} strips (${failureCount} sheet failures from ${inputSheetCount} input)`
			});
		}

		// Audit log for batch record creation
		const batchRecord = await LaserCutBatch.findOne({ operatorId: locals.user._id, outputLotId }).lean() as any;
		await AuditLog.create({
			_id: generateId(),
			tableName: 'laser_cut_batches',
			recordId: batchRecord?._id ?? outputLotId,
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: new Date()
		});

		return { success: true };
	},

	/** Save default settings to ManufacturingSettings */
	saveDefaults: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const defaultLaserTools = (data.get('defaultLaserTools') as string) || undefined;
		const defaultCuttingProgramLink = (data.get('defaultCuttingProgramLink') as string) || undefined;

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{
				$set: {
					'general.defaultLaserTools': defaultLaserTools,
					'general.defaultCuttingProgramLink': defaultCuttingProgramLink
				}
			},
			{ upsert: true }
		);

		return { success: true, defaultsSaved: true };
	}
};

export const config = { maxDuration: 60 };
