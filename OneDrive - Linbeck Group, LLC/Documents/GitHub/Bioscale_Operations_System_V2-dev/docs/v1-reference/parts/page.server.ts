/**
 * Part Detail Page Server
 * Shows all BOM information for a single part from Box.com sync
 */

import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	auditLog,
	bomItem,
	bomItemVersion,
	bomPartLink,
	inspectionProcedureRevision,
	inventoryTransaction,
	partDefinition,
	user
} from '$lib/server/db/schema';
import { requirePermission } from '$lib/server/auth/permissions';
import { eq, desc, inArray, and, isNull, isNotNull, gte, lte, or } from 'drizzle-orm';
import { retractTransaction } from '$lib/server/services/inventory-transaction';
import { uploadIpDocument } from '$lib/server/services/receiving/ip-document';
import { nanoid } from 'nanoid';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	await requirePermission(locals.user, 'part:read');

	const [item] = await db.select().from(bomItem).where(eq(bomItem.id, params.partId)).limit(1);

	if (!item) {
		throw error(404, 'Part not found');
	}

	// Get linked partDefinition for inspection pathway + IP revisions
	const [partDef] = item.partNumber
		? await db
				.select({
					id: partDefinition.id,
					inspectionPathway: partDefinition.inspectionPathway,
					sampleSize: partDefinition.sampleSize,
					percentAccepted: partDefinition.percentAccepted
				})
				.from(partDefinition)
				.where(eq(partDefinition.partNumber, item.partNumber))
				.limit(1)
		: [];

	// Load IP revisions if pathway is 'ip'
	let ipRevisions: Array<{
		id: string;
		revisionNumber: number;
		documentUrl: string;
		renderedHtmlUrl: string | null;
		formDefinition: unknown;
		changeNotes: string | null;
		isCurrent: boolean;
		uploadedAt: Date;
		uploadedByName: string | null;
	}> = [];

	if (partDef?.inspectionPathway === 'ip' && partDef.id) {
		ipRevisions = await db
			.select({
				id: inspectionProcedureRevision.id,
				revisionNumber: inspectionProcedureRevision.revisionNumber,
				documentUrl: inspectionProcedureRevision.documentUrl,
				renderedHtmlUrl: inspectionProcedureRevision.renderedHtmlUrl,
				formDefinition: inspectionProcedureRevision.formDefinition,
				changeNotes: inspectionProcedureRevision.changeNotes,
				isCurrent: inspectionProcedureRevision.isCurrent,
				uploadedAt: inspectionProcedureRevision.uploadedAt,
				uploadedByName: user.username
			})
			.from(inspectionProcedureRevision)
			.leftJoin(user, eq(user.id, inspectionProcedureRevision.uploadedBy))
			.where(eq(inspectionProcedureRevision.partId, partDef.id))
			.orderBy(desc(inspectionProcedureRevision.revisionNumber));
	}

	// Get version history
	const versions = await db
		.select()
		.from(bomItemVersion)
		.where(eq(bomItemVersion.bomItemId, params.partId))
		.orderBy(desc(bomItemVersion.version))
		.limit(10);

	// Find linked part definitions
	const links = await db
		.select({ partDefinitionId: bomPartLink.partDefinitionId })
		.from(bomPartLink)
		.where(eq(bomPartLink.bomItemId, params.partId));

	// Read filter params
	const typeFilter = url.searchParams.get('type');
	const startDate = url.searchParams.get('startDate');
	const endDate = url.searchParams.get('endDate');
	const retractedFilter = url.searchParams.get('retracted');

	let transactions: Array<{
		id: string;
		transactionType: string;
		quantity: number;
		previousQuantity: number;
		newQuantity: number;
		performedAt: Date;
		performedByName: string | null;
		assemblySessionId: string | null;
		retractedAt: Date | null;
	}> = [];

	if (links.length > 0) {
		const partDefIds = links.map((l) => l.partDefinitionId);

		// Build where conditions
		const conditions = [inArray(inventoryTransaction.partDefinitionId, partDefIds)];

		if (typeFilter) {
			conditions.push(eq(inventoryTransaction.transactionType, typeFilter));
		}
		if (startDate) {
			conditions.push(gte(inventoryTransaction.performedAt, new Date(startDate)));
		}
		if (endDate) {
			const end = new Date(endDate);
			end.setHours(23, 59, 59, 999);
			conditions.push(lte(inventoryTransaction.performedAt, end));
		}
		if (retractedFilter === 'yes') {
			conditions.push(isNotNull(inventoryTransaction.retractedAt));
		} else if (retractedFilter === 'no') {
			conditions.push(isNull(inventoryTransaction.retractedAt));
		}

		const txns = await db
			.select({
				id: inventoryTransaction.id,
				transactionType: inventoryTransaction.transactionType,
				quantity: inventoryTransaction.quantity,
				previousQuantity: inventoryTransaction.previousQuantity,
				newQuantity: inventoryTransaction.newQuantity,
				performedAt: inventoryTransaction.performedAt,
				performedByName: user.username,
				assemblySessionId: inventoryTransaction.assemblySessionId,
				retractedAt: inventoryTransaction.retractedAt
			})
			.from(inventoryTransaction)
			.leftJoin(user, eq(user.id, inventoryTransaction.performedBy))
			.where(and(...conditions))
			.orderBy(desc(inventoryTransaction.performedAt))
			.limit(200);

		transactions = txns;
	}

	// Load audit log entries for this part (bomItem and bomItemVersion changes)
	const auditEntries = await db
		.select({
			id: auditLog.id,
			action: auditLog.action,
			oldData: auditLog.oldData,
			newData: auditLog.newData,
			changedAt: auditLog.changedAt,
			changedBy: auditLog.changedBy,
			username: user.username
		})
		.from(auditLog)
		.leftJoin(user, eq(user.id, auditLog.changedBy))
		.where(
			and(
				or(eq(auditLog.tableName, 'bomItem'), eq(auditLog.tableName, 'bomItemVersion')),
				eq(auditLog.recordId, params.partId)
			)
		)
		.orderBy(desc(auditLog.changedAt))
		.limit(50);

	return {
		item: {
			...item,
			unitCost: item.unitCost ? parseFloat(item.unitCost) : null,
			inspectionPathway: (partDef?.inspectionPathway ?? 'coc') as 'coc' | 'ip'
		},
		partDefinitionId: partDef?.id ?? null,
		sampleSize: partDef?.sampleSize ?? 1,
		percentAccepted: partDef?.percentAccepted ?? 100,
		versions,
		inventoryTransactions: transactions,
		filters: {
			type: typeFilter,
			startDate,
			endDate,
			retracted: retractedFilter
		},
		auditEntries,
		ipRevisions
	};
};

export const actions: Actions = {
	retractTransaction: async ({ request, locals }) => {
		const currentUser = locals.user;
		if (!currentUser) {
			return fail(401, { retractError: 'Authentication required.' });
		}
		await requirePermission(currentUser, 'inventory:write');

		const formData = await request.formData();
		const transactionId = formData.get('transactionId') as string;
		const reason = formData.get('reason') as string;

		if (!transactionId || !reason?.trim()) {
			return fail(400, { retractError: 'Transaction ID and reason are required.' });
		}

		const result = await retractTransaction(transactionId, currentUser.id, reason.trim());

		if (!result.success) {
			return fail(400, { retractError: result.error ?? 'Failed to retract transaction.' });
		}

		return { retractSuccess: true, restoredQuantity: result.restoredQuantity };
	},

	uploadIpRevision: async ({ locals, request }) => {
		const currentUser = locals.user;
		if (!currentUser) return fail(401, { ipError: 'Authentication required.' });
		await requirePermission(currentUser, 'part:write');

		const formData = await request.formData();
		const file = formData.get('file') as File | null;
		const partDefinitionId = formData.get('partDefinitionId') as string;
		const changeNotes = (formData.get('changeNotes') as string)?.trim() || undefined;

		if (!file || file.size === 0) return fail(400, { ipError: 'A .docx file is required.' });
		if (!file.name.endsWith('.docx'))
			return fail(400, { ipError: 'Only .docx files are accepted.' });
		if (!partDefinitionId) return fail(400, { ipError: 'Part definition ID is missing.' });

		try {
			await uploadIpDocument({
				file,
				partId: partDefinitionId,
				uploadedBy: currentUser.id,
				changeNotes
			});
			return { ipSuccess: true };
		} catch (e) {
			const message = e instanceof Error ? e.message : 'Upload failed.';
			return fail(500, { ipError: message });
		}
	},

	saveFormDefinition: async ({ locals, request }) => {
		const currentUser = locals.user;
		if (!currentUser) return fail(401, { formDefError: 'Authentication required.' });
		await requirePermission(currentUser, 'part:write');

		const formData = await request.formData();
		const revisionId = formData.get('revisionId') as string;
		const jsonString = formData.get('formDefinition') as string;

		if (!revisionId) return fail(400, { formDefError: 'Revision ID is required.' });
		if (!jsonString?.trim()) return fail(400, { formDefError: 'Form definition is required.' });

		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonString);
		} catch {
			return fail(400, { formDefError: 'Invalid JSON syntax.' });
		}

		// Validate top-level shape
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return fail(400, { formDefError: 'Form definition must be a JSON object.' });
		}

		const obj = parsed as Record<string, unknown>;
		const errors: string[] = [];

		// Validate tools[]
		if (!Array.isArray(obj.tools)) {
			errors.push('Missing or invalid "tools" array.');
		} else {
			for (let i = 0; i < obj.tools.length; i++) {
				const t = obj.tools[i] as Record<string, unknown>;
				if (!t?.tool_id || typeof t.tool_id !== 'string')
					errors.push(`tools[${i}]: missing "tool_id" (string).`);
				if (!t?.name || typeof t.name !== 'string')
					errors.push(`tools[${i}]: missing "name" (string).`);
			}
		}

		// Validate references[]
		if (!Array.isArray(obj.references)) {
			errors.push('Missing or invalid "references" array.');
		} else {
			for (let i = 0; i < obj.references.length; i++) {
				const r = obj.references[i] as Record<string, unknown>;
				if (!r?.ref_id || typeof r.ref_id !== 'string')
					errors.push(`references[${i}]: missing "ref_id" (string).`);
				if (!r?.title || typeof r.title !== 'string')
					errors.push(`references[${i}]: missing "title" (string).`);
			}
		}

		// Validate steps[]
		const validInputTypes = ['pass_fail', 'yes_no', 'dimension', 'visual_inspection'];
		if (!Array.isArray(obj.steps)) {
			errors.push('Missing or invalid "steps" array.');
		} else {
			for (let i = 0; i < obj.steps.length; i++) {
				const s = obj.steps[i] as Record<string, unknown>;
				if (typeof s?.step_order !== 'number')
					errors.push(`steps[${i}]: missing "step_order" (number).`);
				if (!s?.input_type || !validInputTypes.includes(s.input_type as string))
					errors.push(`steps[${i}]: "input_type" must be one of: ${validInputTypes.join(', ')}.`);
				if (!s?.question_label || typeof s.question_label !== 'string')
					errors.push(`steps[${i}]: missing "question_label" (string).`);
			}
		}

		if (errors.length > 0) {
			return fail(400, { formDefError: errors.join(' ') });
		}

		// Verify revision exists and is current
		const [rev] = await db
			.select({ id: inspectionProcedureRevision.id })
			.from(inspectionProcedureRevision)
			.where(
				and(
					eq(inspectionProcedureRevision.id, revisionId),
					eq(inspectionProcedureRevision.isCurrent, true)
				)
			)
			.limit(1);

		if (!rev) {
			return fail(404, { formDefError: 'Current revision not found.' });
		}

		await db
			.update(inspectionProcedureRevision)
			.set({ formDefinition: parsed })
			.where(eq(inspectionProcedureRevision.id, revisionId));

		await db.insert(auditLog).values({
			id: nanoid(),
			tableName: 'inspection_procedure_revision',
			recordId: revisionId,
			action: 'UPDATE',
			oldData: null,
			newData: { formDefinition: 'updated' },
			changedBy: currentUser.id
		});

		return { formDefSuccess: true };
	},

	updateMinStockLevel: async ({ params, locals, request }) => {
		await requirePermission(locals.user, 'part:write');

		const formData = await request.formData();
		const rawLevel = formData.get('minimumStockLevel');
		const level = parseInt(String(rawLevel), 10);

		if (isNaN(level) || level < 0) {
			return fail(400, { error: 'Minimum stock level must be a non-negative integer' });
		}

		const [existing] = await db
			.select({ minimumStockLevel: bomItem.minimumStockLevel })
			.from(bomItem)
			.where(eq(bomItem.id, params.partId))
			.limit(1);

		if (!existing) {
			return fail(404, { error: 'Part not found' });
		}

		const oldLevel = existing.minimumStockLevel;

		await db
			.update(bomItem)
			.set({ minimumStockLevel: level, updatedAt: new Date() })
			.where(eq(bomItem.id, params.partId));

		await db.insert(auditLog).values({
			id: nanoid(),
			tableName: 'bomItem',
			recordId: params.partId,
			action: 'UPDATE',
			oldData: { minimumStockLevel: oldLevel },
			newData: { minimumStockLevel: level },
			changedBy: locals.user?.id ?? null
		});

		return { success: true };
	},

	updateInspectionConfig: async ({ request, locals }) => {
		await requirePermission(locals.user, 'part:write');

		const formData = await request.formData();
		const partDefId = formData.get('partDefinitionId') as string;
		const sampleSize = parseInt(String(formData.get('sampleSize')), 10);
		const percentAccepted = parseFloat(String(formData.get('percentAccepted')));

		if (!partDefId) {
			return fail(400, { inspectionConfigError: 'Part definition ID is required.' });
		}
		if (isNaN(sampleSize) || sampleSize < 1) {
			return fail(400, { inspectionConfigError: 'Sample size must be at least 1.' });
		}
		if (isNaN(percentAccepted) || percentAccepted < 0 || percentAccepted > 100) {
			return fail(400, { inspectionConfigError: 'Percent accepted must be between 0 and 100.' });
		}

		const [existing] = await db
			.select({
				sampleSize: partDefinition.sampleSize,
				percentAccepted: partDefinition.percentAccepted
			})
			.from(partDefinition)
			.where(eq(partDefinition.id, partDefId))
			.limit(1);

		if (!existing) {
			return fail(404, { inspectionConfigError: 'Part definition not found.' });
		}

		await db
			.update(partDefinition)
			.set({
				sampleSize,
				percentAccepted,
				updatedAt: new Date()
			})
			.where(eq(partDefinition.id, partDefId));

		await db.insert(auditLog).values({
			id: nanoid(),
			tableName: 'part_definition',
			recordId: partDefId,
			action: 'UPDATE',
			oldData: {
				sampleSize: existing.sampleSize,
				percentAccepted: existing.percentAccepted
			},
			newData: { sampleSize, percentAccepted },
			changedBy: locals.user?.id ?? null
		});

		return { inspectionConfigSuccess: true };
	}
};
