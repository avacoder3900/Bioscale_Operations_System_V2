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

export type ParsedStepInput = {
	stepNumber: number;
	title: string;
	content: string;
	contentText: string;
	parts: ParsedPart[];
	images: string[];
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

/**
 * Pick the version entry to display/serve for an SPU work instruction.
 *
 * `versions[]` is append-only, and re-parsing the same source document pushes a
 * NEW entry that reuses the existing version number — so version numbers are
 * NOT unique. `versions.find(v => v.version === currentVersion)` therefore
 * returned whichever entry was appended *first*. On the live document that is a
 * Parser v1.2.0 entry with zero parts and no rendered HTML, which is why the
 * page rendered empty while a complete v3.2.0 parse sat further down the array.
 *
 * Rule: newest parse wins — highest version number, then latest `parsedAt`,
 * then latest array position. `isCurrent` reports whether the chosen entry is
 * the inducted `currentVersion`, so callers can flag a draft parse.
 */
export function selectActiveWiVersion(
	wi: any
): { version: any; isCurrent: boolean } | null {
	const versions = (wi?.versions ?? []) as any[];
	if (versions.length === 0) return null;

	const parsedTime = (v: any): number => {
		const t = new Date(v?.parsedAt ?? 0).getTime();
		return Number.isFinite(t) ? t : 0;
	};

	let best = 0;
	for (let i = 1; i < versions.length; i++) {
		const candidate = versions[i];
		const incumbent = versions[best];
		const cv = Number(candidate?.version ?? 0);
		const iv = Number(incumbent?.version ?? 0);
		if (cv > iv || (cv === iv && parsedTime(candidate) >= parsedTime(incumbent))) {
			best = i;
		}
	}

	const chosen = versions[best];
	return {
		version: chosen,
		isCurrent: Number(chosen?.version ?? 0) === Number(wi?.currentVersion ?? 0)
	};
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
	steps?: ParsedStepInput[];
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
		steps: (input.steps ?? []).map((s) => ({
			_id: generateId(),
			stepNumber: s.stepNumber,
			title: s.title,
			content: s.content,
			images: s.images,
			requiresScan: (s.fieldDefinitions ?? []).length > 0,
			partRequirements: s.parts.map((p) => ({
				_id: generateId(),
				partNumber: p.partNumber,
				quantity: p.quantity,
				notes: p.partName
			})),
			fieldDefinitions: s.fieldDefinitions.map((f) => ({
				_id: generateId(),
				fieldName: f.fieldName,
				fieldLabel: f.fieldLabel,
				fieldType: f.fieldType,
				isRequired: f.isRequired,
				barcodeFieldMapping: f.barcodeFieldMapping,
				sortOrder: f.sortOrder
			}))
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
