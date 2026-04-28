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

export type ParsedStep = {
	stepNumber: number;
	title: string;
	content: string;
	partRequirements: Array<{ partNumber: string; quantity: number; partDefinitionId?: string; notes?: string }>;
	fieldDefinitions: FieldDefinition[];
	warnings?: string[];
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
	parsedSteps: ParsedStep[];
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
		changeNotes: `Parser v${input.parserVersion}`,
		parsedAt: new Date(),
		parsedBy: input.preparedBy,
		createdAt: new Date(),
		steps: input.parsedSteps.map((s) => ({
			_id: generateId(),
			stepNumber: s.stepNumber,
			title: s.title,
			content: s.content,
			requiresScan: (s.fieldDefinitions?.length ?? 0) > 0,
			partRequirements: (s.partRequirements ?? []).map((p) => ({
				_id: generateId(),
				partNumber: p.partNumber,
				partDefinitionId: p.partDefinitionId,
				quantity: p.quantity,
				notes: p.notes
			})),
			fieldDefinitions: (s.fieldDefinitions ?? []).map((f) => ({
				_id: generateId(),
				fieldName: f.fieldName,
				fieldLabel: f.fieldLabel,
				fieldType: f.fieldType,
				isRequired: f.isRequired,
				validationPattern: f.validationPattern,
				options: f.options,
				barcodeFieldMapping: f.barcodeFieldMapping,
				sortOrder: f.sortOrder
			})),
			toolRequirements: []
		}))
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
		details: { event: 'draft_version_created', version: nextVersion, versionId }
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
		details: { event: 'inducted', versionId, version: version.version }
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
		details: { event: 'rejected', versionId }
	});
}

function validateInductable(version: any): string[] {
	const errs: string[] = [];
	if (!Array.isArray(version.steps) || version.steps.length === 0) {
		errs.push('No steps');
		return errs;
	}
	for (const step of version.steps) {
		const hasContent = !!step.content && step.content.trim().length > 0;
		const hasParts = Array.isArray(step.partRequirements) && step.partRequirements.length > 0;
		if (!hasContent && !hasParts) errs.push(`Step ${step.stepNumber}: empty`);

		const seen = new Set<string>();
		for (const f of step.fieldDefinitions ?? []) {
			if (!f.fieldName || !f.fieldLabel) errs.push(`Step ${step.stepNumber}: field missing name/label`);
			if (!f.barcodeFieldMapping) errs.push(`Step ${step.stepNumber}: field ${f.fieldName} missing mapping`);
			if (seen.has(f.fieldName)) errs.push(`Step ${step.stepNumber}: duplicate field ${f.fieldName}`);
			seen.add(f.fieldName);
		}
	}
	return errs;
}

export function findVersion(wi: any, versionId: string) {
	return (wi?.versions ?? []).find((v: any) => v._id === versionId);
}
