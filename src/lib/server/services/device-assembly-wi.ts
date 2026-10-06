import { DeviceAssemblyWI, WorkInstructionImage, PartDefinition, AuditLog } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import {
	parseDeviceAssemblyWI,
	sanitizeHtml,
	stripTags,
	parseMaterialLine,
	type StoreImageFn,
	type ParsedDeviceWI,
	type ParsedMaterial
} from './device-assembly-wi-parser';

// Core service for the SPU Assembly Work Instruction.
//
// Deliberately imports only models + the parser (no R2, no $env) so the same
// code runs from a tsx script (scripts/import-device-assembly-wi.ts) and from
// SvelteKit routes. Image storage is injected (see device-assembly-wi-images.ts
// for the R2-first store used by the routes).

export const DEVICE_WI_DOCUMENT_NUMBER = 'WIMF-SPU-01';

export type Actor = { _id: string; username: string };

export type RevisionInput = {
	changeType:
		| 'import' | 'section_rename' | 'step_add' | 'step_edit' | 'step_delete' | 'step_move'
		| 'image_add' | 'image_remove' | 'image_edit' | 'material_add' | 'material_edit' | 'material_remove'
		| 'metadata_edit';
	summary: string;
	location?: { sectionNumber?: number | null; sectionTitle?: string | null; stepNumber?: number | null; stepId?: string | null };
	before?: unknown;
	after?: unknown;
};

export function sectionLabel(section: { type: string; number: number }): string {
	return section.type === 'setup' ? 'Setup' : `Sub-Assembly ${section.number}`;
}

export function versionLabel(version: number): string {
	return `v${version}`;
}

// ───────────────────────────── images (Mongo store) ─────────────────────────────

export async function storeImageInMongo(
	buf: Buffer,
	contentType: string,
	opts: { wiId?: string | null; originalName?: string | null; uploadedBy?: string | null } = {}
): Promise<{ url: string; storage: 'mongo'; id: string }> {
	const id = generateId();
	await WorkInstructionImage.create({
		_id: id,
		wiId: opts.wiId ?? null,
		contentType,
		size: buf.length,
		data: buf,
		originalName: opts.originalName ?? null,
		uploadedBy: opts.uploadedBy ?? null,
		uploadedAt: new Date()
	});
	return { url: `/api/device-assembly/images/${id}`, storage: 'mongo', id };
}

export function mongoImageStore(wiId: string | null, uploadedBy: string | null): StoreImageFn {
	return async (buf, contentType) => storeImageInMongo(buf, contentType, { wiId, uploadedBy });
}

// ───────────────────────────── reads ─────────────────────────────

export async function getDeviceAssemblyWI(): Promise<any | null> {
	const doc = await DeviceAssemblyWI.findOne({ documentNumber: DEVICE_WI_DOCUMENT_NUMBER }).lean();
	return doc ? JSON.parse(JSON.stringify(doc)) : null;
}

export function findSection(wi: any, sectionNumber: number): any | null {
	return (wi.sections ?? []).find((s: any) => Number(s.number) === Number(sectionNumber)) ?? null;
}

export function findStep(section: any, stepRef: { stepId?: string | null; stepNumber?: number | null }): any | null {
	if (!section) return null;
	if (stepRef.stepId) return section.steps.find((s: any) => s._id === stepRef.stepId) ?? null;
	if (stepRef.stepNumber != null) return section.steps.find((s: any) => Number(s.stepNumber) === Number(stepRef.stepNumber)) ?? null;
	return null;
}

/** Locate a step by human reference, e.g. ("step 2 in sub-assembly 2") → (sectionNumber 2, stepNumber 2). */
export function locateStep(wi: any, sectionNumber: number, stepNumber: number) {
	const section = findSection(wi, sectionNumber);
	const step = findStep(section, { stepNumber });
	return { section, step };
}

// ───────────────────────────── part linking ─────────────────────────────

async function buildPartIndex(partNumbers: string[]): Promise<Map<string, { _id: string; name: string }>> {
	const map = new Map<string, { _id: string; name: string }>();
	const wanted = [...new Set(partNumbers.filter(Boolean).map((p) => p.toUpperCase()))];
	if (!wanted.length) return map;
	const parts = await PartDefinition.find({ partNumber: { $in: wanted } }).select('partNumber name').lean();
	for (const p of parts as any[]) map.set(String(p.partNumber).toUpperCase(), { _id: String(p._id), name: p.name });
	return map;
}

/** Fill partDefinitionId on every material whose partNumber exists in the catalog. */
export async function resolvePartLinks(sections: any[]): Promise<{ resolved: number; unresolved: string[] }> {
	const numbers: string[] = [];
	for (const s of sections) for (const st of s.steps ?? []) for (const m of st.materials ?? []) if (m.partNumber) numbers.push(m.partNumber);
	const index = await buildPartIndex(numbers);
	let resolved = 0;
	const unresolved = new Set<string>();
	for (const s of sections) {
		for (const st of s.steps ?? []) {
			for (const m of st.materials ?? []) {
				if (!m.partNumber) continue;
				const hit = index.get(String(m.partNumber).toUpperCase());
				if (hit) { m.partDefinitionId = hit._id; resolved++; }
				else { m.partDefinitionId = null; if (m.kind === 'part') unresolved.add(m.partNumber); }
			}
		}
	}
	return { resolved, unresolved: [...unresolved].sort() };
}

// ───────────────────────────── import ─────────────────────────────

function countSteps(sections: any[]): number {
	return (sections ?? []).reduce((n: number, s: any) => n + (s.steps?.length ?? 0), 0);
}

export async function importDeviceAssemblyWI(
	file: { buffer: Buffer; mimeType: string; originalName: string },
	actor: Actor,
	storeImage: StoreImageFn
): Promise<{ wiId: string; version: number; parsed: ParsedDeviceWI; unresolved: string[] }> {
	const parsed = await parseDeviceAssemblyWI(file, storeImage);
	const sections: any[] = parsed.sections.map((s) => ({
		_id: generateId(),
		type: s.type,
		number: s.number,
		title: s.title,
		notesHtml: s.notesHtml,
		materialsHtml: s.materialsHtml,
		steps: s.steps.map((st) => ({
			_id: generateId(),
			stepNumber: st.stepNumber,
			title: st.title,
			instructionsHtml: st.instructionsHtml,
			instructionsText: st.instructionsText,
			images: st.images.map((im) => ({ _id: generateId(), url: im.url, alt: im.alt, caption: '', storage: im.storage, addedAt: new Date(), addedBy: actor.username })),
			materials: st.materials.map((m) => ({ _id: generateId(), ...m, partDefinitionId: null })),
			requiresEsd: st.requiresEsd,
			dhrFields: st.dhrFields
		}))
	}));
	for (const s of sections) renumber(s);
	const { unresolved } = await resolvePartLinks(sections);
	if (unresolved.length) parsed.warnings.push(`Part numbers not found in catalog: ${unresolved.join(', ')}`);

	const now = new Date();
	const sourceFile = {
		originalFileName: file.originalName,
		fileSize: file.buffer.length,
		mimeType: file.mimeType,
		uploadedAt: now,
		uploadedBy: actor.username,
		parserVersion: parsed.parserVersion,
		warnings: parsed.warnings
	};
	const existing = await DeviceAssemblyWI.findOne({ documentNumber: DEVICE_WI_DOCUMENT_NUMBER });
	const stepCount = countSteps(sections);
	const summaryTail = `${sections.length} sections, ${stepCount} steps, ${parsed.imageCount} images`;

	if (!existing) {
		const id = generateId();
		await DeviceAssemblyWI.create({
			_id: id,
			documentNumber: DEVICE_WI_DOCUMENT_NUMBER,
			title: parsed.title,
			assemblyNumber: parsed.assemblyNumber,
			status: 'active',
			currentVersion: 1,
			frontMatter: parsed.frontMatter,
			sections,
			sourceFile,
			revisions: [{
				_id: generateId(),
				version: 1,
				label: versionLabel(1),
				changeType: 'import',
				summary: `Imported ${file.originalName}: ${summaryTail}`,
				location: {},
				before: null,
				after: { fileName: file.originalName, sections: sections.length, steps: stepCount, images: parsed.imageCount },
				changedBy: actor,
				changedAt: now
			}],
			createdBy: actor,
			lastChangedBy: actor,
			lastChangedAt: now
		});
		await audit(id, 'INSERT', actor, { event: 'import', version: 1, fileName: file.originalName, steps: stepCount });
		return { wiId: id, version: 1, parsed, unresolved };
	}

	const before = {
		fileName: existing.sourceFile?.originalFileName ?? null,
		sections: existing.sections?.length ?? 0,
		steps: countSteps(existing.sections ?? []),
		version: existing.currentVersion
	};
	const nextVersion = (existing.currentVersion ?? 0) + 1;
	existing.title = parsed.title;
	existing.assemblyNumber = parsed.assemblyNumber || existing.assemblyNumber;
	existing.frontMatter = parsed.frontMatter;
	existing.sections = sections;
	existing.sourceFile = sourceFile;
	existing.currentVersion = nextVersion;
	existing.lastChangedBy = actor;
	existing.lastChangedAt = now;
	existing.revisions.push({
		_id: generateId(),
		version: nextVersion,
		label: versionLabel(nextVersion),
		changeType: 'import',
		summary: `Re-imported from ${file.originalName}: ${summaryTail} (replaced previous content)`,
		location: {},
		before,
		after: { fileName: file.originalName, sections: sections.length, steps: stepCount, images: parsed.imageCount },
		changedBy: actor,
		changedAt: now
	});
	await existing.save();
	await audit(String(existing._id), 'UPDATE', actor, { event: 'reimport', version: nextVersion, fileName: file.originalName, steps: stepCount });
	return { wiId: String(existing._id), version: nextVersion, parsed, unresolved };
}

async function audit(wiId: string, action: string, actor: Actor, newData: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'device_assembly_work_instructions',
		recordId: wiId,
		action,
		newData,
		changedAt: new Date(),
		changedBy: actor.username
	});
}

// ───────────────────────────── revision-tracked mutations ─────────────────────────────

export function renumber(section: any) {
	section.steps.forEach((s: any, i: number) => { s.stepNumber = i + 1; });
}

/**
 * Load the WI, apply `mutate`, bump the version and append the revision the
 * mutation describes — all in one save. Every change to the instruction
 * goes through here so the revision tracker can never be skipped.
 */
export async function mutateDeviceAssemblyWI(
	actor: Actor,
	mutate: (doc: any) => RevisionInput | Promise<RevisionInput>
): Promise<{ version: number; label: string; summary: string }> {
	const doc = await DeviceAssemblyWI.findOne({ documentNumber: DEVICE_WI_DOCUMENT_NUMBER });
	if (!doc) throw new Error('No SPU Assembly Work Instruction has been imported yet');
	const rev = await mutate(doc);
	const nextVersion = (doc.currentVersion ?? 0) + 1;
	const now = new Date();
	doc.revisions.push({
		_id: generateId(),
		version: nextVersion,
		label: versionLabel(nextVersion),
		changeType: rev.changeType,
		summary: rev.summary,
		location: {
			sectionNumber: rev.location?.sectionNumber ?? null,
			sectionTitle: rev.location?.sectionTitle ?? null,
			stepNumber: rev.location?.stepNumber ?? null,
			stepId: rev.location?.stepId ?? null
		},
		before: rev.before ?? null,
		after: rev.after ?? null,
		changedBy: actor,
		changedAt: now
	});
	doc.currentVersion = nextVersion;
	doc.lastChangedBy = actor;
	doc.lastChangedAt = now;
	doc.markModified('sections');
	doc.markModified('frontMatter');
	await doc.save();
	await audit(String(doc._id), 'UPDATE', actor, { event: rev.changeType, version: nextVersion, summary: rev.summary, location: rev.location ?? null });
	return { version: nextVersion, label: versionLabel(nextVersion), summary: rev.summary };
}

function requireSection(doc: any, sectionNumber: number) {
	const section = findSection(doc, sectionNumber);
	if (!section) throw new Error(`Section ${sectionNumber} not found`);
	return section;
}
function requireStep(section: any, stepId: string) {
	const step = findStep(section, { stepId });
	if (!step) throw new Error(`Step not found in ${sectionLabel(section)}`);
	return step;
}
function where(section: any, step?: any) {
	return {
		sectionNumber: section.number,
		sectionTitle: section.title,
		stepNumber: step?.stepNumber ?? null,
		stepId: step?._id ?? null
	};
}
function stepRef(section: any, step: any) {
	return `step ${step.stepNumber} in ${sectionLabel(section)}`;
}

export function renameSection(actor: Actor, sectionNumber: number, title: string) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const before = section.title;
		section.title = title.trim();
		return { changeType: 'section_rename', summary: `Renamed ${sectionLabel(section)} from "${before}" to "${section.title}"`, location: where(section), before: { title: before }, after: { title: section.title } };
	});
}

export function updateSectionNotes(actor: Actor, sectionNumber: number, notesHtml: string) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const before = section.notesHtml;
		section.notesHtml = sanitizeHtml(notesHtml);
		return { changeType: 'metadata_edit', summary: `Edited notes for ${sectionLabel(section)}`, location: where(section), before: { notesHtml: before }, after: { notesHtml: section.notesHtml } };
	});
}

export function updateStep(
	actor: Actor,
	sectionNumber: number,
	stepId: string,
	patch: { title?: string; instructionsHtml?: string; requiresEsd?: boolean; dhrFields?: string[] }
) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const before: Record<string, unknown> = {};
		const after: Record<string, unknown> = {};
		const changed: string[] = [];
		if (patch.title != null && patch.title.trim() !== step.title) {
			before.title = step.title; step.title = patch.title.trim(); after.title = step.title; changed.push('title');
		}
		if (patch.instructionsHtml != null) {
			const html = sanitizeHtml(patch.instructionsHtml);
			if (html !== step.instructionsHtml) {
				before.instructionsHtml = step.instructionsHtml;
				step.instructionsHtml = html;
				step.instructionsText = stripTags(html);
				after.instructionsHtml = html;
				changed.push('instructions');
			}
		}
		if (patch.requiresEsd != null && patch.requiresEsd !== Boolean(step.requiresEsd)) {
			before.requiresEsd = step.requiresEsd; step.requiresEsd = patch.requiresEsd; after.requiresEsd = patch.requiresEsd; changed.push('ESD flag');
		}
		if (patch.dhrFields) {
			const next = patch.dhrFields.map((f) => f.trim()).filter(Boolean);
			if (JSON.stringify(next) !== JSON.stringify(step.dhrFields ?? [])) {
				before.dhrFields = step.dhrFields; step.dhrFields = next; after.dhrFields = next; changed.push('DHR fields');
			}
		}
		if (!changed.length) throw new Error('No changes to save');
		return { changeType: 'step_edit', summary: `Edited ${stepRef(section, step)} (${changed.join(', ')})`, location: where(section, step), before, after };
	});
}

export function addStep(
	actor: Actor,
	sectionNumber: number,
	input: { title: string; instructionsHtml: string; afterStepId?: string | null; requiresEsd?: boolean }
) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const html = sanitizeHtml(input.instructionsHtml || '');
		const step = {
			_id: generateId(),
			stepNumber: 0,
			title: input.title.trim(),
			instructionsHtml: html,
			instructionsText: stripTags(html),
			images: [],
			materials: [],
			requiresEsd: Boolean(input.requiresEsd),
			dhrFields: []
		};
		let idx = section.steps.length;
		if (input.afterStepId) {
			const i = section.steps.findIndex((s: any) => s._id === input.afterStepId);
			if (i >= 0) idx = i + 1;
		}
		section.steps.splice(idx, 0, step);
		renumber(section);
		return { changeType: 'step_add', summary: `Added ${stepRef(section, step)}: "${step.title || stripTags(html).slice(0, 60)}"`, location: where(section, step), before: null, after: { title: step.title, instructionsHtml: html } };
	});
}

export function deleteStep(actor: Actor, sectionNumber: number, stepId: string) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const ref = stepRef(section, step);
		const snapshot = JSON.parse(JSON.stringify(step));
		section.steps = section.steps.filter((s: any) => s._id !== stepId);
		renumber(section);
		return { changeType: 'step_delete', summary: `Deleted ${ref}: "${step.title}"`, location: { ...where(section), stepNumber: snapshot.stepNumber, stepId }, before: snapshot, after: null };
	});
}

export function moveStep(actor: Actor, fromSection: number, stepId: string, toSection: number, toPosition: number | null) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const src = requireSection(doc, fromSection);
		const dst = requireSection(doc, toSection);
		const step = requireStep(src, stepId);
		const fromRef = stepRef(src, step);
		src.steps = src.steps.filter((s: any) => s._id !== stepId);
		if (src !== dst) renumber(src);
		let idx = toPosition == null ? dst.steps.length : Math.max(0, Math.min(dst.steps.length, toPosition - 1));
		dst.steps.splice(idx, 0, step);
		renumber(dst);
		return { changeType: 'step_move', summary: `Moved ${fromRef} to ${stepRef(dst, step)}`, location: where(dst, step), before: { sectionNumber: src.number, stepNumber: Number(fromRef.match(/step (\d+)/)?.[1]) }, after: { sectionNumber: dst.number, stepNumber: step.stepNumber } };
	});
}

export function addStepImages(
	actor: Actor,
	sectionNumber: number,
	stepId: string,
	images: { url: string; alt?: string; caption?: string; storage: 'r2' | 'mongo' | 'inline' | 'external' }[]
) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const added = images.map((im) => ({ _id: generateId(), url: im.url, alt: im.alt ?? '', caption: im.caption ?? '', storage: im.storage, addedAt: new Date(), addedBy: actor.username }));
		step.images.push(...added);
		return { changeType: 'image_add', summary: `Added ${added.length} image${added.length === 1 ? '' : 's'} to ${stepRef(section, step)}`, location: where(section, step), before: null, after: { images: added.map((a) => ({ _id: a._id, url: a.url, caption: a.caption })) } };
	});
}

export function removeStepImage(actor: Actor, sectionNumber: number, stepId: string, imageId: string) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const img = step.images.find((i: any) => i._id === imageId);
		if (!img) throw new Error('Image not found');
		const position = step.images.indexOf(img) + 1;
		step.images = step.images.filter((i: any) => i._id !== imageId);
		return { changeType: 'image_remove', summary: `Removed image ${position} from ${stepRef(section, step)}`, location: where(section, step), before: { _id: img._id, url: img.url, caption: img.caption }, after: null };
	});
}

export function updateStepImage(actor: Actor, sectionNumber: number, stepId: string, imageId: string, patch: { caption?: string; alt?: string }) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const img = step.images.find((i: any) => i._id === imageId);
		if (!img) throw new Error('Image not found');
		const before = { caption: img.caption, alt: img.alt };
		if (patch.caption != null) img.caption = patch.caption.trim();
		if (patch.alt != null) img.alt = patch.alt.trim();
		const position = step.images.indexOf(img) + 1;
		return { changeType: 'image_edit', summary: `Edited caption of image ${position} in ${stepRef(section, step)}`, location: where(section, step), before, after: { caption: img.caption, alt: img.alt } };
	});
}

export function moveStepImage(actor: Actor, sectionNumber: number, stepId: string, imageId: string, direction: 'up' | 'down') {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const i = step.images.findIndex((im: any) => im._id === imageId);
		if (i < 0) throw new Error('Image not found');
		const j = direction === 'up' ? i - 1 : i + 1;
		if (j < 0 || j >= step.images.length) throw new Error('Image is already at the edge');
		const arr = step.images;
		[arr[i], arr[j]] = [arr[j], arr[i]];
		return { changeType: 'image_edit', summary: `Reordered images in ${stepRef(section, step)} (image ${i + 1} → ${j + 1})`, location: where(section, step), before: { position: i + 1 }, after: { position: j + 1 } };
	});
}

export type MaterialInput = {
	kind: 'part' | 'tool' | 'aid' | 'supply';
	partNumber?: string | null;
	name: string;
	quantity: number;
	unit?: string;
	deductFromInventory?: boolean;
	notes?: string;
};

async function linkOne(material: any) {
	if (!material.partNumber) { material.partDefinitionId = null; return; }
	const index = await buildPartIndex([material.partNumber]);
	const hit = index.get(String(material.partNumber).toUpperCase());
	material.partDefinitionId = hit?._id ?? null;
}

export function addMaterial(actor: Actor, sectionNumber: number, stepId: string, input: MaterialInput) {
	return mutateDeviceAssemblyWI(actor, async (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const material: any = {
			_id: generateId(),
			kind: input.kind,
			partNumber: input.partNumber ? input.partNumber.trim().toUpperCase() : null,
			partDefinitionId: null,
			name: input.name.trim(),
			quantity: input.quantity,
			unit: (input.unit || 'ea').trim().toLowerCase(),
			deductFromInventory: input.deductFromInventory ?? input.kind === 'part',
			notes: input.notes ?? '',
			rawText: ''
		};
		await linkOne(material);
		step.materials.push(material);
		return { changeType: 'material_add', summary: `Added material "${material.name}"${material.partNumber ? ` (${material.partNumber})` : ''} x${material.quantity} ${material.unit} to ${stepRef(section, step)}`, location: where(section, step), before: null, after: material };
	});
}

/** Convenience: add a material from a bullet in document syntax, e.g. "Heater Block (PT-SPU-013) x1". */
export function addMaterialFromText(actor: Actor, sectionNumber: number, stepId: string, text: string) {
	const parsed: ParsedMaterial | null = parseMaterialLine(text);
	if (!parsed) throw new Error('Could not parse material. Use the form "Name (PT-SPU-000) x1".');
	return addMaterial(actor, sectionNumber, stepId, parsed);
}

export function updateMaterial(actor: Actor, sectionNumber: number, stepId: string, materialId: string, patch: Partial<MaterialInput>) {
	return mutateDeviceAssemblyWI(actor, async (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const material = step.materials.find((m: any) => m._id === materialId);
		if (!material) throw new Error('Material not found');
		const before = JSON.parse(JSON.stringify(material));
		if (patch.kind) material.kind = patch.kind;
		if (patch.name != null) material.name = patch.name.trim();
		if (patch.quantity != null) material.quantity = patch.quantity;
		if (patch.unit != null) material.unit = patch.unit.trim().toLowerCase() || 'ea';
		if (patch.notes != null) material.notes = patch.notes;
		if (patch.deductFromInventory != null) material.deductFromInventory = patch.deductFromInventory;
		if (patch.partNumber !== undefined) {
			material.partNumber = patch.partNumber ? patch.partNumber.trim().toUpperCase() : null;
			await linkOne(material);
		}
		return { changeType: 'material_edit', summary: `Edited material "${material.name}" in ${stepRef(section, step)}`, location: where(section, step), before, after: JSON.parse(JSON.stringify(material)) };
	});
}

export function removeMaterial(actor: Actor, sectionNumber: number, stepId: string, materialId: string) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const step = requireStep(section, stepId);
		const material = step.materials.find((m: any) => m._id === materialId);
		if (!material) throw new Error('Material not found');
		step.materials = step.materials.filter((m: any) => m._id !== materialId);
		return { changeType: 'material_remove', summary: `Removed material "${material.name}" from ${stepRef(section, step)}`, location: where(section, step), before: JSON.parse(JSON.stringify(material)), after: null };
	});
}

/** Re-run part-number → PartDefinition linking for the whole document (after catalog changes). */
export function relinkAllParts(actor: Actor) {
	return mutateDeviceAssemblyWI(actor, async (doc) => {
		const { resolved, unresolved } = await resolvePartLinks(doc.sections);
		return { changeType: 'metadata_edit', summary: `Re-linked materials to the parts catalog (${resolved} linked, ${unresolved.length} unresolved)`, after: { resolved, unresolved } };
	});
}
