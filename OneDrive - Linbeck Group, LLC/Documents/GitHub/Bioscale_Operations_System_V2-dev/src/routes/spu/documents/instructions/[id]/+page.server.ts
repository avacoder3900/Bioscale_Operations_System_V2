import { error, fail } from '@sveltejs/kit';
import { connectDB, WorkInstruction, ProductionRun, User, PartDefinition } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();
	const wi = await WorkInstruction.findById(params.id).lean() as any;
	if (!wi) error(404, 'Work instruction not found');

	// Get the current version
	const currentVersion = (wi.versions ?? []).find(
		(v: any) => v.version === wi.currentVersion
	) ?? (wi.versions ?? []).slice(-1)[0];

	// Get production runs linked to this work instruction
	const runs = await ProductionRun.find({ workInstructionId: params.id })
		.sort({ createdAt: -1 }).limit(50).lean();

	const builderIds = [...new Set(runs.map((r: any) => r.leadBuilder?._id).filter(Boolean))];
	const builders = builderIds.length > 0
		? await User.find({ _id: { $in: builderIds } }).select('_id username').lean()
		: [];
	const builderMap = new Map(builders.map((u: any) => [u._id, u.username]));

	// Validate all part requirements against PartDefinition catalog
	const allPartNumbers = (currentVersion?.steps ?? []).flatMap(
		(s: any) => (s.partRequirements ?? []).map((pr: any) => pr.partNumber).filter(Boolean)
	);
	const uniquePartNumbers = [...new Set(allPartNumbers)] as string[];
	const partDefs = uniquePartNumbers.length
		? await PartDefinition.find({ partNumber: { $in: uniquePartNumbers } }).lean()
		: [];
	const partDefMap = new Map((partDefs as any[]).map((p: any) => [p.partNumber, p]));

	const partValidation = uniquePartNumbers.map((pn: string) => {
		const def = partDefMap.get(pn);
		// Sum total quantity needed across all steps for this part
		const totalQtyNeeded = (currentVersion?.steps ?? []).reduce((sum: number, s: any) => {
			const req = (s.partRequirements ?? []).find((pr: any) => pr.partNumber === pn);
			return sum + (req?.quantity ?? 0);
		}, 0);
		return {
			partNumber: pn,
			exists: !!def,
			partDefinitionId: (def as any)?._id ?? null,
			name: (def as any)?.name ?? null,
			inventoryCount: (def as any)?.inventoryCount ?? 0,
			totalQtyNeeded,
			sufficient: !!def && ((def as any).inventoryCount ?? 0) >= totalQtyNeeded
		};
	});

	const allPartsValid = partValidation.every((p) => p.exists && p.sufficient);

	return {
		instruction: {
			id: wi._id,
			title: wi.title ?? '',
			documentNumber: wi.documentNumber ?? '',
			version: wi.currentVersion ?? 1,
			status: wi.status ?? 'draft',
			category: wi.category ?? null,
			content: currentVersion?.content ?? null,
			steps: (currentVersion?.steps ?? []).map((s: any) => ({
				id: s._id,
				stepNumber: s.stepNumber ?? 0,
				title: s.title ?? '',
				description: s.content ?? '',
				partRequirements: (s.partRequirements ?? []).map((pr: any) => ({
					id: pr._id,
					partNumber: pr.partNumber ?? '',
					partDefinitionId: pr.partDefinitionId ?? null,
					quantity: pr.quantity ?? 1,
					notes: pr.notes ?? null
				})),
				fields: (s.fieldDefinitions ?? []).map((f: any) => ({
					id: f._id,
					fieldName: f.fieldName ?? '',
					fieldLabel: f.fieldLabel ?? '',
					fieldType: f.fieldType ?? 'manual_entry',
					isRequired: f.isRequired ?? false,
					options: f.options ?? null
				}))
			})),
			createdAt: wi.createdAt,
			updatedAt: wi.updatedAt
		},
		partValidation,
		allPartsValid,
		runs: runs.map((r: any) => ({
			id: r._id,
			runNumber: r.runNumber ?? '',
			status: r.status ?? 'planning',
			startedAt: r.startedAt ?? r.createdAt,
			completedAt: r.completedAt ?? null,
			operatorName: r.leadBuilder?._id ? (builderMap.get(r.leadBuilder._id) ?? r.leadBuilder.username ?? 'Unknown') : 'Unknown'
		}))
	};
};

export const actions: Actions = {
	validateParts: async ({ params }) => {
		await connectDB();
		const wi = await WorkInstruction.findById(params.id).lean() as any;
		if (!wi) return fail(404, { error: 'Work instruction not found' });

		const currentVersion = (wi.versions ?? []).find(
			(v: any) => v.version === wi.currentVersion
		) ?? (wi.versions ?? []).slice(-1)[0];

		const allPartNumbers = (currentVersion?.steps ?? []).flatMap(
			(s: any) => (s.partRequirements ?? []).map((pr: any) => pr.partNumber).filter(Boolean)
		);
		const uniquePartNumbers = [...new Set(allPartNumbers)] as string[];

		if (!uniquePartNumbers.length) {
			return fail(400, { error: 'No part requirements defined in this work instruction' });
		}

		const partDefs = await PartDefinition.find({ partNumber: { $in: uniquePartNumbers } }).lean();
		const partDefMap = new Map((partDefs as any[]).map((p: any) => [p.partNumber, p]));

		const issues: string[] = [];
		const validated: { partNumber: string; name: string; qtyNeeded: number; qtyAvailable: number; status: string }[] = [];

		for (const pn of uniquePartNumbers) {
			const def = partDefMap.get(pn) as any;
			const totalQtyNeeded = (currentVersion?.steps ?? []).reduce((sum: number, s: any) => {
				const req = (s.partRequirements ?? []).find((pr: any) => pr.partNumber === pn);
				return sum + (req?.quantity ?? 0);
			}, 0);

			if (!def) {
				issues.push(`Part ${pn} not found in parts catalog`);
				validated.push({ partNumber: pn, name: '(not found)', qtyNeeded: totalQtyNeeded, qtyAvailable: 0, status: 'missing' });
			} else if ((def.inventoryCount ?? 0) < totalQtyNeeded) {
				issues.push(`Part ${pn} (${def.name}): need ${totalQtyNeeded}, have ${def.inventoryCount ?? 0}`);
				validated.push({ partNumber: pn, name: def.name, qtyNeeded: totalQtyNeeded, qtyAvailable: def.inventoryCount ?? 0, status: 'insufficient' });
			} else {
				validated.push({ partNumber: pn, name: def.name, qtyNeeded: totalQtyNeeded, qtyAvailable: def.inventoryCount ?? 0, status: 'ok' });
			}
		}

		// Also link partDefinitionIds back to the WI if missing
		let linkedCount = 0;
		const wiDoc = await WorkInstruction.findById(params.id) as any;
		if (wiDoc) {
			const ver = (wiDoc.versions ?? []).find((v: any) => v.version === wiDoc.currentVersion)
				?? (wiDoc.versions ?? []).slice(-1)[0];
			let changed = false;
			for (const step of ver?.steps ?? []) {
				for (const pr of step.partRequirements ?? []) {
					if (!pr.partDefinitionId && pr.partNumber) {
						const def = partDefMap.get(pr.partNumber) as any;
						if (def) {
							pr.partDefinitionId = def._id;
							changed = true;
							linkedCount++;
						}
					}
				}
			}
			if (changed) await wiDoc.save();
		}

		return {
			success: issues.length === 0,
			validated,
			issues,
			linkedCount,
			message: issues.length === 0
				? `All ${uniquePartNumbers.length} parts validated successfully${linkedCount ? ` (${linkedCount} part IDs linked)` : ''}`
				: `${issues.length} issue(s) found`
		};
	}
};
