import { connectDB } from '$lib/server/db/connection';
import { WorkInstruction, AuditLog, generateId } from '$lib/server/db';

export const SPU_WI_DOCUMENT_TYPE = 'spu_creation';

export type FieldDefinition = {
	fieldName: string;
	fieldLabel: string;
	fieldType: 'barcode_scan' | 'manual_entry' | 'date_picker' | 'dropdown';
	isRequired: boolean;
	validationPattern?: string;
	options?: any;
	barcodeFieldMapping?: string;
	sortOrder: number;
};

export type ParsedPart = {
	anchorId: string;
	partNumber: string;
	partName: string;
	quantity: number;
	fieldDefinitions: FieldDefinition[];
};

export async function getActiveSpuWorkInstruction() {
	await connectDB();
	return WorkInstruction.findOne({
		documentType: SPU_WI_DOCUMENT_TYPE,
		status: 'active'
	}).lean();
}

export async function getSpuWorkInstructionDoc() {
	await connectDB();
	return WorkInstruction.findOne({ documentType: SPU_WI_DOCUMENT_TYPE });
}

export async function createSpuWiDraftVersion(input: {
	title?: string;
	revision?: string;
	fileId?: string;
	originalFileName?: string;
	fileSize?: number;
	mimeType?: string;
	rawContent: string;
	renderedHtml: string;
	parts: ParsedPart[];
	parserVersion: string;
	preparedBy: string;
}): Promise<{ workInstructionId: string; versionId: string; version: number }> {
	await connectDB();

	let wi: any = await WorkInstruction.findOne({ documentType: SPU_WI_DOCUMENT_TYPE });
	if (!wi) {
		wi = await WorkInstruction.create({
			_id: generateId(),
			documentNumber: 'WI-SPU-CREATION',
			title: input.title ?? 'SPU Creation Work Instruction',
			documentType: SPU_WI_DOCUMENT_TYPE,
			status: 'draft',
			currentVersion: 0,
			revision: input.revision ?? 'A',
			category: 'spu_creation',
			fileId: input.fileId,
			originalFileName: input.originalFileName,
			fileSize: input.fileSize,
			mimeType: input.mimeType,
			preparedBy: input.preparedBy,
			preparedAt: new Date(),
			versions: [],
			createdBy: input.preparedBy
		});
	}

	const nextVersion = ((wi.currentVersion as number) ?? 0) + (wi.versions?.length ? 1 : 1);
	const versionId = generateId();

	const versionEntry = {
		_id: versionId,
		version: nextVersion,
		content: input.rawContent.slice(0, 200_000),
		rawContent: input.rawContent,
		renderedHtml: input.renderedHtml,
		changeNotes: `Parser v${input.parserVersion}`,
		parsedAt: new Date(),
		parsedBy: input.preparedBy,
		createdAt: new Date(),
		parts: input.parts.map((p) => ({
			_id: generateId(),
			anchorId: p.anchorId,
			partNumber: p.partNumber,
			partName: p.partName,
			quantity: p.quantity,
			fieldDefinitions: p.fieldDefinitions.map((f) => ({
				_id: generateId(),
				fieldName: f.fieldName,
				fieldLabel: f.fieldLabel,
				fieldType: f.fieldType,
				isRequired: f.isRequired,
				barcodeFieldMapping: f.barcodeFieldMapping,
				sortOrder: f.sortOrder
			}))
		})),
		steps: []
	};

	await WorkInstruction.updateOne(
		{ _id: wi._id },
		{
			$push: { versions: versionEntry },
			$set: {
				originalFileName: input.originalFileName,
				fileSize: input.fileSize,
				mimeType: input.mimeType,
				fileId: input.fileId
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'work_instructions',
		recordId: wi._id,
		action: 'UPDATE',
		changedBy: input.preparedBy,
		changedAt: new Date(),
		newData: { event: 'draft_version_created', version: nextVersion, versionId, partCount: input.parts.length }
	});

	return { workInstructionId: wi._id, versionId, version: nextVersion };
}

export async function inductSpuWiVersion(
	workInstructionId: string,
	versionId: string,
	actor: { _id: string; username: string }
): Promise<void> {
	await connectDB();

	const wi: any = await WorkInstruction.findById(workInstructionId);
	if (!wi) throw new Error('Work instruction not found');

	const version = (wi.versions ?? []).find((v: any) => v._id === versionId);
	if (!version) throw new Error('Draft version not found');

	const errors = validateInductable(version);
	if (errors.length) {
		throw new Error(`Cannot induct: ${errors.join('; ')}`);
	}

	await WorkInstruction.updateMany(
		{ documentType: SPU_WI_DOCUMENT_TYPE, status: 'active', _id: { $ne: workInstructionId } },
		{ $set: { status: 'retired' } }
	);

	await WorkInstruction.updateOne(
		{ _id: workInstructionId },
		{
			$set: {
				documentType: SPU_WI_DOCUMENT_TYPE,
				status: 'active',
				currentVersion: version.version,
				effectiveDate: new Date(),
				reviewedBy: actor.username,
				reviewedAt: new Date(),
				approvedBy: actor.username,
				approvedAt: new Date()
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'work_instructions',
		recordId: workInstructionId,
		action: 'UPDATE',
		changedBy: actor.username,
		changedAt: new Date(),
		newData: { event: 'inducted', versionId, version: version.version }
	});
}

export async function rejectSpuWiVersion(
	workInstructionId: string,
	versionId: string,
	actor: { _id: string; username: string }
): Promise<void> {
	await connectDB();

	await WorkInstruction.updateOne(
		{ _id: workInstructionId, 'versions._id': versionId },
		{ $set: { 'versions.$.changeNotes': `discarded by ${actor.username} at ${new Date().toISOString()}` } }
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'work_instructions',
		recordId: workInstructionId,
		action: 'UPDATE',
		changedBy: actor.username,
		changedAt: new Date(),
		newData: { event: 'rejected', versionId }
	});
}

function validateInductable(version: any): string[] {
	const errs: string[] = [];
	if (!version.renderedHtml || typeof version.renderedHtml !== 'string' || version.renderedHtml.trim().length === 0) {
		errs.push('No rendered document body');
	}
	if (!Array.isArray(version.parts) || version.parts.length === 0) {
		errs.push('No parts detected — at least one (PT-SPU-NNN) reference required');
	}
	const seenAnchors = new Set<string>();
	for (const p of version.parts ?? []) {
		if (!p.anchorId) errs.push(`part ${p.partNumber}: missing anchorId`);
		if (seenAnchors.has(p.anchorId)) errs.push(`duplicate anchorId ${p.anchorId}`);
		seenAnchors.add(p.anchorId);
		if (!p.partNumber || !/^PT-SPU-\d{3,}$/.test(p.partNumber)) {
			errs.push(`invalid partNumber: ${p.partNumber}`);
		}
		if (!Number.isFinite(p.quantity) || p.quantity < 1 || p.quantity > 999) {
			errs.push(`part ${p.partNumber}: invalid quantity ${p.quantity}`);
		}
		if (!Array.isArray(p.fieldDefinitions) || p.fieldDefinitions.length !== p.quantity) {
			errs.push(`part ${p.partNumber}: expected ${p.quantity} field defs, got ${p.fieldDefinitions?.length ?? 0}`);
		}
	}
	return errs;
}

export function findVersion(wi: any, versionId: string) {
	return (wi?.versions ?? []).find((v: any) => v._id === versionId);
}
