import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { partDefinition, inspectionProcedureRevision, auditLog, receivingLot } from '$lib/server/db/schema';
import { requirePermission } from '$lib/server/auth/permissions';
import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { env } from '$env/dynamic/private';
import { uploadImage } from '$lib/server/integrations/supabase-storage';
import {
	createLot,
	isLotIdUnique,
	createToolConfirmations,
	createInspectionResults
} from '$lib/server/services/receiving/lot';
import type { InspectionResultInput } from '$lib/server/services/receiving/lot';
import { updateInventoryOnLotAcceptance } from '$lib/server/services/receiving/inventory-update';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	await requirePermission(locals.user, 'part:read');

	const parts = await db
		.select({
			id: partDefinition.id,
			partNumber: partDefinition.partNumber,
			name: partDefinition.name,
			category: partDefinition.category,
			manufacturer: partDefinition.manufacturer,
			inspectionPathway: partDefinition.inspectionPathway,
			sampleSize: partDefinition.sampleSize,
			percentAccepted: partDefinition.percentAccepted
		})
		.from(partDefinition)
		.where(eq(partDefinition.isActive, true))
		.orderBy(asc(partDefinition.sortOrder), asc(partDefinition.name));

	const currentRevisions = await db
		.select({
			partId: inspectionProcedureRevision.partId,
			id: inspectionProcedureRevision.id,
			formDefinition: inspectionProcedureRevision.formDefinition,
			revisionNumber: inspectionProcedureRevision.revisionNumber,
			renderedHtmlUrl: inspectionProcedureRevision.renderedHtmlUrl,
			uploadedAt: inspectionProcedureRevision.uploadedAt
		})
		.from(inspectionProcedureRevision)
		.where(eq(inspectionProcedureRevision.isCurrent, true));

	const ipRevisionMap: Record<
		string,
		{
			id: string;
			formDefinition: unknown;
			revisionNumber: number;
			renderedHtmlUrl: string | null;
			uploadedAt: Date;
		}
	> = {};
	for (const rev of currentRevisions) {
		ipRevisionMap[rev.partId] = {
			id: rev.id,
			formDefinition: rev.formDefinition,
			revisionNumber: rev.revisionNumber,
			renderedHtmlUrl: rev.renderedHtmlUrl,
			uploadedAt: rev.uploadedAt
		};
	}

	return { parts, ipRevisionMap };
};

export const actions: Actions = {
	uploadCoc: async ({ request, locals }) => {
		await requirePermission(locals.user, 'part:write');

		const formData = await request.formData();
		const file = formData.get('cocFile') as File | null;
		const partId = formData.get('partId')?.toString();

		if (!file || !partId) return fail(400, { error: 'File and part are required' });

		const timestamp = Date.now();
		const ext = file.name.split('.').pop() ?? 'bin';
		const path = `receiving/coc/${partId}/${timestamp}.${ext}`;

		try {
			const url = await uploadImage(path, file, file.type);
			return { success: true, cocUrl: url };
		} catch (err) {
			return fail(500, { error: err instanceof Error ? err.message : 'Upload failed' });
		}
	},

	validateOverride: async ({ request, locals }) => {
		await requirePermission(locals.user, 'part:write');

		const formData = await request.formData();
		const password = formData.get('adminPassword')?.toString();
		const reason = formData.get('overrideReason')?.toString();

		if (!reason || reason.length < 10) {
			return fail(400, { overrideError: 'Override reason must be at least 10 characters' });
		}

		if (!env.ADMIN_OVERRIDE_PASSWORD) {
			return fail(500, { overrideError: 'Override system not configured' });
		}

		if (password !== env.ADMIN_OVERRIDE_PASSWORD) {
			return fail(403, { overrideError: 'Invalid admin password' });
		}

		return { overrideApproved: true };
	},

	createLot: async ({ request, locals }) => {
		await requirePermission(locals.user, 'part:write');

		const formData = await request.formData();
		const lotId = formData.get('lotId')?.toString()?.trim();
		const partId = formData.get('partId')?.toString();
		const quantity = Number(formData.get('quantity'));
		const pathway = formData.get('pathway')?.toString() as 'coc' | 'ip';
		const cocDocumentUrl = formData.get('cocDocumentUrl')?.toString() || undefined;
		const poReference = formData.get('poReference')?.toString() || undefined;
		const supplier = formData.get('supplier')?.toString() || undefined;
		const vendorLotNumber = formData.get('vendorLotNumber')?.toString() || undefined;
		const expirationStr = formData.get('expirationDate')?.toString();
		const expirationDate = expirationStr ? new Date(expirationStr) : undefined;
		const ipRevisionId = formData.get('ipRevisionId')?.toString() || undefined;
		const confirmedToolsJson = formData.get('confirmedTools')?.toString();
		const inspectionResultsJson = formData.get('inspectionResults')?.toString();
		const overrideApplied = formData.get('overrideApplied') === 'true';
		const overrideReason = formData.get('overrideReason')?.toString() || undefined;
		const status = (formData.get('status')?.toString() as 'accepted' | 'rejected') || undefined;
		const rejectionReason = formData.get('rejectionReason')?.toString() || undefined;
		const rejectionNextSteps = formData.get('rejectionNextSteps')?.toString() || undefined;

		if (!lotId) return fail(400, { error: 'Lot ID (barcode) is required' });
		if (!partId) return fail(400, { error: 'Part is required' });
		if (!quantity || quantity <= 0) return fail(400, { error: 'Valid quantity is required' });

		const unique = await isLotIdUnique(lotId);
		if (!unique) return fail(400, { error: 'Lot ID already exists. Scan a different barcode.' });

		// Parse inspection results if present
		let ipResultsSummary: unknown = undefined;
		const inspectionResultRows: InspectionResultInput[] = [];
		if (inspectionResultsJson) {
			const parsed = JSON.parse(inspectionResultsJson) as {
				result: string;
				passRate: number;
				percentRequired: number;
				responses: Record<
					string,
					Record<string, { value: string; result: string; notes?: string }>
				>;
				steps: {
					step_order: number;
					input_type: string;
					question_label: string;
					tool_id?: string;
				}[];
			};
			ipResultsSummary = {
				result: parsed.result,
				passRate: parsed.passRate,
				percentRequired: parsed.percentRequired
			};
			// Flatten responses into inspection_result rows
			const stepMap = new Map(parsed.steps.map((s) => [s.step_order, s]));
			for (const [sampleNum, stepResponses] of Object.entries(parsed.responses)) {
				for (const [stepOrder, resp] of Object.entries(stepResponses)) {
					const stepDef = stepMap.get(Number(stepOrder));
					inspectionResultRows.push({
						sampleNumber: Number(sampleNum),
						stepOrder: Number(stepOrder),
						inputType: stepDef?.input_type ?? 'unknown',
						questionLabel: stepDef?.question_label ?? '',
						actualValue: resp.value,
						result: resp.result,
						toolUsed: stepDef?.tool_id,
						notes: resp.notes
					});
				}
			}
		}

		try {
			const lot = await createLot({
				lotId,
				partId,
				quantity,
				operatorId: locals.user!.id,
				inspectionPathway: pathway,
				cocDocumentUrl,
				ipResults: ipResultsSummary,
				ipRevisionId,
				poReference,
				supplier,
				vendorLotNumber,
				expirationDate,
				overrideApplied,
				overrideReason,
				overrideBy: overrideApplied ? locals.user!.id : undefined,
				status
			});

			if (confirmedToolsJson) {
				const confirmedTools = JSON.parse(confirmedToolsJson) as {
					tool_id: string;
					name: string;
				}[];
				await createToolConfirmations(lot.lotId, confirmedTools, locals.user!.id);
			}

			if (inspectionResultRows.length > 0) {
				await createInspectionResults(lot.lotId, inspectionResultRows, locals.user!.id);
			}

			if (lot.status === 'accepted') {
				await updateInventoryOnLotAcceptance(partId, quantity, lotId, locals.user!.id);
			}

			if (overrideApplied) {
				await db.insert(auditLog).values({
					id: nanoid(),
					tableName: 'receiving_lot',
					recordId: lot.lotId,
					action: 'OVERRIDE',
					newData: {
						overrideReason,
						overrideBy: locals.user!.id,
						inspectionResult: ipResultsSummary
					},
					changedBy: locals.user!.id
				});
			}

			if (lot.status === 'rejected') {
				await db.insert(auditLog).values({
					id: nanoid(),
					tableName: 'receiving_lot',
					recordId: lot.lotId,
					action: 'REJECT',
					newData: {
						rejectionReason,
						rejectionNextSteps,
						inspectionResult: ipResultsSummary
					},
					changedBy: locals.user!.id
				});
			}

			// Upload photos and documents if provided
			const photoFiles = formData.getAll('lotPhotos') as File[];
			const docFiles = formData.getAll('lotDocuments') as File[];
			const photoUrls: string[] = [];
			const docUrls: string[] = [];

			for (const file of photoFiles) {
				if (!file.size) continue;
				const ts = Date.now();
				const ext = file.name.split('.').pop() ?? 'jpg';
				const path = `receiving/lot-photos/${lot.lotId}/${ts}-${nanoid(6)}.${ext}`;
				const url = await uploadImage(path, file, file.type);
				photoUrls.push(url);
			}

			for (const file of docFiles) {
				if (!file.size) continue;
				const ts = Date.now();
				const ext = file.name.split('.').pop() ?? 'bin';
				const path = `receiving/lot-docs/${lot.lotId}/${ts}-${nanoid(6)}.${ext}`;
				const url = await uploadImage(path, file, file.type);
				docUrls.push(url);
			}

			if (photoUrls.length > 0 || docUrls.length > 0) {
				await db
					.update(receivingLot)
					.set({
						...(photoUrls.length > 0 ? { photos: photoUrls } : {}),
						...(docUrls.length > 0 ? { additionalDocuments: docUrls } : {})
					})
					.where(eq(receivingLot.lotId, lot.lotId));
			}

			return { success: true, lotCreated: true, lotId: lot.lotId };
		} catch (err) {
			return fail(500, { error: err instanceof Error ? err.message : 'Failed to create lot' });
		}
	}
};
