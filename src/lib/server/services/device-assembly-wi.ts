import { DeviceAssemblyWI, DeviceAssemblyWISnapshot, WorkInstructionImage, PartDefinition, AuditLog } from '$lib/server/db/models/index.js';
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
		| 'metadata_edit' | 'section_add' | 'section_delete' | 'section_move' | 'front_matter_edit' | 'revert';
	summary: string;
	location?: { sectionNumber?: number | null; sectionTitle?: string | null; stepNumber?: number | null; stepId?: string | null };
	before?: unknown;
	after?: unknown;
};

export function sectionLabel(section: { type: string; number: number }): string {
	return section.type === 'setup' ? 'Setup' : `Sub-Assembly ${section.number}`;
}

/** Text shown on the section's tab: custom tabLabel if set, else the positional label. */
export function tabLabel(section: { type: string; number: number; tabLabel?: string | null }): string {
	return section.tabLabel?.trim() || sectionLabel(section);
}

/** There is one SPU Assembly WI; find it regardless of its (editable) document number. */
function wiQuery() {
	return DeviceAssemblyWI.findOne({}).sort({ createdAt: 1 });
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
	const doc = await wiQuery().lean();
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
	const existing = await wiQuery();
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
	const doc = await wiQuery();
	if (!doc) throw new Error('No SPU Assembly Work Instruction has been imported yet');
	// Make sure the state we are about to change is restorable.
	await ensureSnapshot(doc);
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
	await ensureSnapshot(doc);
	await audit(String(doc._id), 'UPDATE', actor, { event: rev.changeType, version: nextVersion, summary: rev.summary, location: rev.location ?? null });
	return { version: nextVersion, label: versionLabel(nextVersion), summary: rev.summary };
}

/** Write the full-content snapshot for the document's current version if none exists yet. */
async function ensureSnapshot(doc: any) {
	const version = doc.currentVersion ?? 0;
	const exists = await DeviceAssemblyWISnapshot.exists({ wiId: String(doc._id), version });
	if (exists) return;
	const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
	await DeviceAssemblyWISnapshot.create({
		_id: generateId(),
		wiId: String(doc._id),
		version,
		label: versionLabel(version),
		title: plain.title,
		documentNumber: plain.documentNumber,
		assemblyNumber: plain.assemblyNumber,
		status: plain.status,
		frontMatter: JSON.parse(JSON.stringify(plain.frontMatter ?? null)),
		sections: JSON.parse(JSON.stringify(plain.sections ?? [])),
		takenAt: new Date()
	});
}

export async function listSnapshots(wiId: string): Promise<{ version: number; label: string; takenAt: Date }[]> {
	const rows = await DeviceAssemblyWISnapshot.find({ wiId }).select('version label takenAt').sort({ version: -1 }).lean();
	return rows.map((r: any) => ({ version: r.version, label: r.label, takenAt: r.takenAt }));
}

/** Restore the document content (sections, front matter, title/numbers) to an earlier version. Recorded as a new revision. */
export function revertToVersion(actor: Actor, version: number, reason?: string) {
	return mutateDeviceAssemblyWI(actor, async (doc) => {
		const snap: any = await DeviceAssemblyWISnapshot.findOne({ wiId: String(doc._id), version }).lean();
		if (!snap) {
			const have = await listSnapshots(String(doc._id));
			throw new Error(`No snapshot for v${version}. Restorable versions: ${have.map((h) => h.label).join(', ') || 'none yet'}`);
		}
		if (version === doc.currentVersion) throw new Error(`The document is already at v${version}`);
		const before = { version: doc.currentVersion, title: doc.title, sections: doc.sections.map((s: any) => ({ number: s.number, title: s.title, steps: s.steps.length })) };
		doc.title = snap.title || doc.title;
		doc.documentNumber = snap.documentNumber || doc.documentNumber;
		doc.assemblyNumber = snap.assemblyNumber ?? doc.assemblyNumber;
		if (snap.status) doc.status = snap.status;
		doc.frontMatter = snap.frontMatter ?? doc.frontMatter;
		doc.sections = snap.sections ?? [];
		const after = { restoredVersion: version, sections: doc.sections.map((s: any) => ({ number: s.number, title: s.title, steps: s.steps.length })) };
		return { changeType: 'revert', summary: `Restored content to v${version}${reason ? ` — ${reason}` : ''} (was v${before.version})`, before, after };
	});
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

// ───────────────────────────── sections / front matter / metadata ─────────────────────────────

/** Setup stays number 0; sub-assemblies are renumbered 1..N in array order. */
export function renumberSections(doc: any) {
	const setup = doc.sections.filter((s: any) => s.type === 'setup');
	const subs = doc.sections.filter((s: any) => s.type !== 'setup');
	setup.forEach((s: any) => { s.number = 0; });
	subs.forEach((s: any, i: number) => { s.number = i + 1; });
	doc.sections = [...setup, ...subs];
}

/** Rewrite default "Sub-Assembly N" titles after renumbering so labels and numbers stay in step. */
function refreshDefaultTitles(doc: any, before: Map<string, number>) {
	for (const s of doc.sections) {
		const prev = before.get(s._id);
		if (prev != null && prev !== s.number && s.type !== 'setup' && s.title === `Sub-Assembly ${prev}`) s.title = `Sub-Assembly ${s.number}`;
	}
}

export function addSection(actor: Actor, input: { title?: string; position?: number | null; type?: 'setup' | 'subassembly'; notesHtml?: string }) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const type = input.type ?? 'subassembly';
		if (type === 'setup') {
			if (doc.sections.some((s: any) => s.type === 'setup')) throw new Error('A Setup section already exists');
			const section = { _id: generateId(), type: 'setup', number: 0, title: input.title?.trim() || 'Cleaning and Setup', notesHtml: sanitizeHtml(input.notesHtml ?? ''), materialsHtml: '', steps: [] };
			doc.sections.unshift(section);
			renumberSections(doc);
			return { changeType: 'section_add', summary: `Added Setup section "${section.title}"`, location: where(section), before: null, after: { title: section.title, number: 0 } };
		}
		const subs = doc.sections.filter((s: any) => s.type !== 'setup');
		let idx = subs.length; // 0-based position among sub-assemblies
		if (input.position != null && Number.isFinite(input.position)) idx = Math.max(0, Math.min(subs.length, Math.floor(input.position) - 1));
		const before = new Map<string, number>(doc.sections.map((s: any) => [s._id, s.number]));
		const section = { _id: generateId(), type: 'subassembly', number: idx + 1, title: input.title?.trim() || `Sub-Assembly ${idx + 1}`, notesHtml: sanitizeHtml(input.notesHtml ?? ''), materialsHtml: '', steps: [] };
		// insert among sub-assemblies, keep setup first
		const setup = doc.sections.filter((s: any) => s.type === 'setup');
		subs.splice(idx, 0, section);
		doc.sections = [...setup, ...subs];
		renumberSections(doc);
		refreshDefaultTitles(doc, before);
		const shifted = subs.length - 1 - idx;
		return {
			changeType: 'section_add',
			summary: `Added ${sectionLabel(section)} "${section.title}"${shifted ? ` (${shifted} later sub-assembl${shifted === 1 ? 'y' : 'ies'} renumbered)` : ''}`,
			location: where(section),
			before: null,
			after: { number: section.number, title: section.title }
		};
	});
}

export function deleteSection(actor: Actor, sectionNumber: number, opts: { moveStepsTo?: number | null } = {}) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const label = sectionLabel(section);
		const snapshot = JSON.parse(JSON.stringify(section));
		let movedTo: any = null;
		if (section.steps.length) {
			if (opts.moveStepsTo == null) throw new Error(`${label} still has ${section.steps.length} step(s). Move them first, or pass moveStepsTo = the section that should receive them.`);
			movedTo = requireSection(doc, opts.moveStepsTo);
			if (movedTo._id === section._id) throw new Error('moveStepsTo must be a different section');
			movedTo.steps.push(...section.steps);
			renumber(movedTo);
		}
		const subsLeft = doc.sections.filter((s: any) => s.type !== 'setup' && s._id !== section._id).length;
		if (section.type !== 'setup' && subsLeft === 0) throw new Error('Cannot delete the last sub-assembly');
		const before = new Map<string, number>(doc.sections.map((s: any) => [s._id, s.number]));
		doc.sections = doc.sections.filter((s: any) => s._id !== section._id);
		renumberSections(doc);
		refreshDefaultTitles(doc, before);
		return {
			changeType: 'section_delete',
			summary: `Deleted ${label} "${snapshot.title}"${movedTo ? ` (its ${snapshot.steps.length} step(s) moved to ${sectionLabel(movedTo)})` : ''}; later sub-assemblies renumbered`,
			location: { sectionNumber: snapshot.number, sectionTitle: snapshot.title, stepNumber: null, stepId: null },
			before: { number: snapshot.number, title: snapshot.title, steps: snapshot.steps.map((st: any) => ({ stepId: st._id, stepNumber: st.stepNumber, title: st.title })) },
			after: movedTo ? { stepsMovedTo: movedTo.number } : null
		};
	});
}

export function moveSection(actor: Actor, sectionNumber: number, toPosition: number) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		if (section.type === 'setup') throw new Error('The Setup section always stays first');
		const subs = doc.sections.filter((s: any) => s.type !== 'setup');
		const from = subs.findIndex((s: any) => s._id === section._id);
		const to = Math.max(0, Math.min(subs.length - 1, Math.floor(toPosition) - 1));
		if (from === to) throw new Error(`${sectionLabel(section)} is already at position ${to + 1}`);
		const before = new Map<string, number>(doc.sections.map((s: any) => [s._id, s.number]));
		subs.splice(from, 1);
		subs.splice(to, 0, section);
		doc.sections = [...doc.sections.filter((s: any) => s.type === 'setup'), ...subs];
		renumberSections(doc);
		refreshDefaultTitles(doc, before);
		return { changeType: 'section_move', summary: `Moved "${section.title}" from Sub-Assembly ${from + 1} to Sub-Assembly ${to + 1} (others renumbered)`, location: where(section), before: { number: from + 1 }, after: { number: to + 1 } };
	});
}

export type FrontMatterPatch = {
	purposeHtml?: string; scopeHtml?: string; responsibilitiesHtml?: string; generalNotesHtml?: string;
	definitions?: string[]; references?: string[];
};

export function updateFrontMatter(actor: Actor, patch: FrontMatterPatch) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const fm = doc.frontMatter;
		const before: Record<string, unknown> = {};
		const after: Record<string, unknown> = {};
		const changed: string[] = [];
		for (const k of ['purposeHtml', 'scopeHtml', 'responsibilitiesHtml', 'generalNotesHtml'] as const) {
			if (patch[k] == null) continue;
			const html = sanitizeHtml(patch[k]!);
			if (html === (fm[k] ?? '')) continue;
			before[k] = fm[k]; fm[k] = html; after[k] = html; changed.push(k.replace('Html', ''));
		}
		for (const k of ['definitions', 'references'] as const) {
			if (!patch[k]) continue;
			const next = patch[k]!.map((x) => String(x).trim()).filter(Boolean);
			if (JSON.stringify(next) === JSON.stringify(fm[k] ?? [])) continue;
			before[k] = fm[k]; fm[k] = next; after[k] = next; changed.push(k);
		}
		if (!changed.length) throw new Error('No changes to save');
		return { changeType: 'front_matter_edit', summary: `Edited front matter (${changed.join(', ')})`, before, after };
	});
}

export function updateMetadata(actor: Actor, patch: { title?: string; assemblyNumber?: string; status?: 'draft' | 'active' | 'retired'; documentNumber?: string }) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const before: Record<string, unknown> = {};
		const after: Record<string, unknown> = {};
		const changed: string[] = [];
		if (patch.title != null && patch.title.trim() && patch.title.trim() !== doc.title) { before.title = doc.title; doc.title = patch.title.trim(); after.title = doc.title; changed.push('title'); }
		if (patch.assemblyNumber != null && patch.assemblyNumber.trim() !== (doc.assemblyNumber ?? '')) { before.assemblyNumber = doc.assemblyNumber; doc.assemblyNumber = patch.assemblyNumber.trim(); after.assemblyNumber = doc.assemblyNumber; changed.push('assembly number'); }
		if (patch.status && patch.status !== doc.status) { before.status = doc.status; doc.status = patch.status; after.status = patch.status; changed.push('status'); }
		if (patch.documentNumber != null && patch.documentNumber.trim() && patch.documentNumber.trim() !== doc.documentNumber) { before.documentNumber = doc.documentNumber; doc.documentNumber = patch.documentNumber.trim(); after.documentNumber = doc.documentNumber; changed.push('document number'); }
		if (!changed.length) throw new Error('No changes to save');
		return { changeType: 'metadata_edit', summary: `Edited document ${changed.join(', ')}`, before, after };
	});
}

// ───────────────────────────── section fields, bulk step ops, copy ─────────────────────────────

export function updateSection(actor: Actor, sectionNumber: number, patch: { title?: string; tabLabel?: string | null; notesHtml?: string; materialsHtml?: string }) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const before: Record<string, unknown> = {};
		const after: Record<string, unknown> = {};
		const changed: string[] = [];
		if (patch.title != null && patch.title.trim() && patch.title.trim() !== section.title) { before.title = section.title; section.title = patch.title.trim(); after.title = section.title; changed.push('title'); }
		if (patch.tabLabel !== undefined) {
			const next = (patch.tabLabel ?? '').trim();
			if (next !== (section.tabLabel ?? '')) { before.tabLabel = section.tabLabel ?? ''; section.tabLabel = next; after.tabLabel = next; changed.push(next ? `tab label → "${next}"` : 'tab label reset to default'); }
		}
		if (patch.notesHtml != null) { const html = sanitizeHtml(patch.notesHtml); if (html !== (section.notesHtml ?? '')) { before.notesHtml = section.notesHtml; section.notesHtml = html; after.notesHtml = html; changed.push('notes'); } }
		if (patch.materialsHtml != null) { const html = sanitizeHtml(patch.materialsHtml); if (html !== (section.materialsHtml ?? '')) { before.materialsHtml = section.materialsHtml; section.materialsHtml = html; after.materialsHtml = html; changed.push('materials table'); } }
		if (!changed.length) throw new Error('No changes to save');
		return { changeType: 'section_rename', summary: `Edited ${sectionLabel(section)} (${changed.join(', ')})`, location: where(section), before, after };
	});
}

function pickSteps(section: any, refs: { stepIds?: string[]; stepNumbers?: number[]; from?: number | null; to?: number | null }): any[] {
	const ids = new Set(refs.stepIds ?? []);
	const nums = new Set(refs.stepNumbers ?? []);
	if (refs.from != null || refs.to != null) {
		const a = refs.from ?? 1;
		const b = refs.to ?? section.steps.length;
		for (let n = Math.min(a, b); n <= Math.max(a, b); n++) nums.add(n);
	}
	const picked = section.steps.filter((s: any) => ids.has(s._id) || nums.has(s.stepNumber));
	if (!picked.length) throw new Error(`No matching steps in ${sectionLabel(section)} (it has ${section.steps.length})`);
	return picked;
}

/** Move several steps at once (by numbers, a from–to range, or ids) to another section, keeping their order. */
export function moveSteps(actor: Actor, fromSection: number, refs: { stepIds?: string[]; stepNumbers?: number[]; from?: number | null; to?: number | null }, toSection: number, toPosition: number | null) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const src = requireSection(doc, fromSection);
		const dst = requireSection(doc, toSection);
		const picked = pickSteps(src, refs);
		const pickedIds = new Set(picked.map((s: any) => s._id));
		const fromNumbers = picked.map((s: any) => s.stepNumber);
		src.steps = src.steps.filter((s: any) => !pickedIds.has(s._id));
		if (src !== dst) renumber(src);
		const idx = toPosition == null ? dst.steps.length : Math.max(0, Math.min(dst.steps.length, toPosition - 1));
		dst.steps.splice(idx, 0, ...picked);
		renumber(dst);
		const first = picked[0].stepNumber, last = picked[picked.length - 1].stepNumber;
		return {
			changeType: 'step_move',
			summary: `Moved ${picked.length} steps (${sectionLabel(src)} ${fromNumbers[0]}–${fromNumbers[fromNumbers.length - 1]}) to ${sectionLabel(dst)} steps ${first}–${last}`,
			location: where(dst, picked[0]),
			before: { sectionNumber: src.number, stepNumbers: fromNumbers },
			after: { sectionNumber: dst.number, stepNumbers: picked.map((s: any) => s.stepNumber) }
		};
	});
}

export function deleteSteps(actor: Actor, sectionNumber: number, refs: { stepIds?: string[]; stepNumbers?: number[]; from?: number | null; to?: number | null }) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const section = requireSection(doc, sectionNumber);
		const picked = pickSteps(section, refs);
		const ids = new Set(picked.map((s: any) => s._id));
		const snapshot = JSON.parse(JSON.stringify(picked));
		section.steps = section.steps.filter((s: any) => !ids.has(s._id));
		renumber(section);
		return {
			changeType: 'step_delete',
			summary: `Deleted ${picked.length} steps from ${sectionLabel(section)} (were ${snapshot.map((s: any) => s.stepNumber).join(', ')})`,
			location: where(section),
			before: snapshot,
			after: null
		};
	});
}

/** Duplicate a step (text, images, materials) into a section; the copy gets new ids. */
export function copyStep(actor: Actor, fromSection: number, stepId: string, toSection: number, toPosition: number | null) {
	return mutateDeviceAssemblyWI(actor, (doc) => {
		const src = requireSection(doc, fromSection);
		const dst = requireSection(doc, toSection);
		const step = requireStep(src, stepId);
		const clone = JSON.parse(JSON.stringify(step));
		clone._id = generateId();
		clone.images = (clone.images ?? []).map((im: any) => ({ ...im, _id: generateId() }));
		clone.materials = (clone.materials ?? []).map((m: any) => ({ ...m, _id: generateId() }));
		const idx = toPosition == null ? dst.steps.length : Math.max(0, Math.min(dst.steps.length, toPosition - 1));
		dst.steps.splice(idx, 0, clone);
		renumber(dst);
		return { changeType: 'step_add', summary: `Copied ${stepRef(src, step)} to ${stepRef(dst, clone)}`, location: where(dst, clone), before: null, after: { copiedFrom: { sectionNumber: src.number, stepNumber: step.stepNumber }, stepId: clone._id } };
	});
}
