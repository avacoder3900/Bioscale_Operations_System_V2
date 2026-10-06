import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { resolveActor, ActorError } from '$lib/server/machine-actor';
import {
	renameSection, updateSectionNotes, updateStep, addStep, deleteStep, moveStep,
	addStepImages, removeStepImage, updateStepImage, moveStepImage,
	addMaterial, addMaterialFromText, updateMaterial, removeMaterial, relinkAllParts,
	importDeviceAssemblyWI, getDeviceAssemblyWI, sectionLabel
} from '$lib/server/services/device-assembly-wi';
import { makeDeviceWiImageStore } from '$lib/server/services/device-assembly-wi-images';
import { RefError, requireWI, resolveSection, resolveStep, resolveMaterial, resolveImage, loadImageInput, stepView, stockIndex } from '$lib/server/services/device-assembly-wi-agent';
import type { RequestHandler } from './$types';

/**
 * POST /api/agent/device-assembly/mutate — every revision-tracked change to the WI.
 * Body: { op, actor, ...params }. Every op bumps the version and records who/when/what.
 *
 * ops: rename_section, set_section_notes, update_step, add_step, delete_step, move_step,
 *      add_image, remove_image, set_image_caption, reorder_image,
 *      add_material, update_material, remove_material, relink_parts, import
 */
export const POST: RequestHandler = async ({ request, fetch }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body: any = await request.json().catch(() => ({}));
	const op = String(body.op ?? '');
	if (!op) throw error(400, 'op is required');

	let actor;
	try {
		const r = await resolveActor(body.actor);
		actor = { _id: r.userId, username: r.username };
	} catch (e: any) {
		if (e instanceof ActorError) throw error(400, e.message);
		throw e;
	}

	const text = (v: unknown) => (v == null ? '' : String(v));
	const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

	try {
		if (op === 'import') {
			if (body.confirmed !== true) throw error(400, 'confirmed must be true — importing replaces every section and step');
			if (!body.fileUrl) throw error(400, 'fileUrl (.docx) is required');
			const res = await fetch(String(body.fileUrl));
			if (!res.ok) throw error(400, `Could not fetch ${body.fileUrl} (${res.status})`);
			const buffer = Buffer.from(await res.arrayBuffer());
			const name = String(body.fileName ?? new URL(String(body.fileUrl)).pathname.split('/').pop() ?? 'work-instruction.docx');
			const existing = await getDeviceAssemblyWI();
			const r = await importDeviceAssemblyWI({ buffer, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', originalName: name }, actor, makeDeviceWiImageStore({ wiId: existing?._id ?? null, uploadedBy: actor.username }));
			return json({ success: true, data: { version: r.version, label: `v${r.version}`, sections: r.parsed.sections.map((s) => ({ number: s.number, title: s.title, steps: s.steps.length })), images: r.parsed.imageCount, partsNotInCatalog: r.unresolved, warnings: r.parsed.warnings } }, { status: 201 });
		}

		const wi = await requireWI();

		if (op === 'relink_parts') {
			return json({ success: true, data: await relinkAllParts(actor) });
		}
		if (op === 'rename_section') {
			const s = resolveSection(wi, body.section);
			if (!text(body.title).trim()) throw error(400, 'title is required');
			return json({ success: true, data: await renameSection(actor, s.number, text(body.title)) });
		}
		if (op === 'set_section_notes') {
			const s = resolveSection(wi, body.section);
			return json({ success: true, data: await updateSectionNotes(actor, s.number, toHtml(text(body.notes))) });
		}
		if (op === 'add_step') {
			const s = resolveSection(wi, body.section);
			let afterStepId: string | null = null;
			if (body.afterStep != null && body.afterStep !== '') afterStepId = resolveStep(wi, s.number, body.afterStep).step._id;
			const r = await addStep(actor, s.number, { title: text(body.title), instructionsHtml: body.instructionsHtml ? String(body.instructionsHtml) : toHtml(text(body.instructions)), afterStepId, requiresEsd: Boolean(body.requiresEsd) });
			return json({ success: true, data: r }, { status: 201 });
		}

		// ---- everything below addresses one existing step
		const { section, step } = resolveStep(wi, body.section, body.step ?? body.stepId);
		const where = { sectionNumber: section.number, section: sectionLabel(section), stepNumber: step.stepNumber, stepId: step._id };

		switch (op) {
			case 'update_step': {
				const patch: any = {};
				if (body.title != null) patch.title = text(body.title);
				if (body.instructionsHtml != null) patch.instructionsHtml = String(body.instructionsHtml);
				else if (body.instructions != null) patch.instructionsHtml = toHtml(text(body.instructions));
				else if (body.appendInstructions != null) patch.instructionsHtml = (step.instructionsHtml || '') + toHtml(text(body.appendInstructions));
				if (body.requiresEsd != null) patch.requiresEsd = Boolean(body.requiresEsd);
				if (Array.isArray(body.dhrFields)) patch.dhrFields = body.dhrFields.map(String);
				return json({ success: true, data: { ...where, ...(await updateStep(actor, section.number, step._id, patch)) } });
			}
			case 'delete_step': {
				if (body.confirmed !== true) throw error(400, `confirmed must be true — ask the user to confirm deleting step ${step.stepNumber} ("${step.title}") in ${sectionLabel(section)}`);
				return json({ success: true, data: { ...where, ...(await deleteStep(actor, section.number, step._id)) } });
			}
			case 'move_step': {
				const dst = resolveSection(wi, body.toSection ?? section.number);
				return json({ success: true, data: { ...where, ...(await moveStep(actor, section.number, step._id, dst.number, num(body.toPosition))) } });
			}
			case 'add_image': {
				const img = await loadImageInput(body, fetch);
				const store = makeDeviceWiImageStore({ wiId: wi._id, uploadedBy: actor.username, keyPrefix: `device-wi/${wi._id}/step-${step._id}/${Date.now()}` });
				const stored = await store(img.buf, img.contentType, 1);
				const r = await addStepImages(actor, section.number, step._id, [{ url: stored.url, storage: stored.storage, alt: text(body.alt) || img.name, caption: text(body.caption) }]);
				return json({ success: true, data: { ...where, ...r, url: stored.url } }, { status: 201 });
			}
			case 'remove_image': {
				const { image } = resolveImage(step, body.image);
				return json({ success: true, data: { ...where, ...(await removeStepImage(actor, section.number, step._id, image._id)) } });
			}
			case 'set_image_caption': {
				const { image } = resolveImage(step, body.image);
				return json({ success: true, data: { ...where, ...(await updateStepImage(actor, section.number, step._id, image._id, { caption: text(body.caption), alt: body.alt != null ? text(body.alt) : undefined })) } });
			}
			case 'reorder_image': {
				const { image } = resolveImage(step, body.image);
				const dir = body.direction === 'up' || body.direction === 'earlier' ? 'up' : 'down';
				return json({ success: true, data: { ...where, ...(await moveStepImage(actor, section.number, step._id, image._id, dir)) } });
			}
			case 'add_material': {
				if (body.text) return json({ success: true, data: { ...where, ...(await addMaterialFromText(actor, section.number, step._id, String(body.text))) } }, { status: 201 });
				if (!text(body.name).trim()) throw error(400, 'name is required (or pass text like "Heater Block (PT-SPU-013) x1")');
				const kind = body.kind ?? (body.partNumber ? (String(body.partNumber).toUpperCase().startsWith('TOOL-') ? 'tool' : 'part') : 'part');
				if (!['part', 'tool', 'aid', 'supply'].includes(kind)) throw error(400, 'kind must be part | tool | aid | supply');
				const quantity = num(body.quantity) ?? 1;
				if (!(quantity > 0)) throw error(400, 'quantity must be > 0');
				return json({ success: true, data: { ...where, ...(await addMaterial(actor, section.number, step._id, { kind, name: text(body.name), quantity, unit: text(body.unit) || 'ea', partNumber: text(body.partNumber) || null, notes: text(body.notes) })) } }, { status: 201 });
			}
			case 'update_material': {
				const m = resolveMaterial(step, text(body.material));
				const patch: any = {};
				for (const k of ['name', 'unit', 'kind', 'notes'] as const) if (body[k] != null) patch[k] = text(body[k]);
				if (body.quantity != null) { const q = num(body.quantity); if (!(q != null && q > 0)) throw error(400, 'quantity must be > 0'); patch.quantity = q; }
				if (body.partNumber !== undefined) patch.partNumber = text(body.partNumber) || null;
				if (body.deductFromInventory != null) patch.deductFromInventory = Boolean(body.deductFromInventory);
				return json({ success: true, data: { ...where, ...(await updateMaterial(actor, section.number, step._id, m._id, patch)) } });
			}
			case 'remove_material': {
				const m = resolveMaterial(step, text(body.material));
				return json({ success: true, data: { ...where, ...(await removeMaterial(actor, section.number, step._id, m._id)) } });
			}
			case 'get': {
				return json({ success: true, data: stepView(section, step, await stockIndex(wi), { full: true }) });
			}
			default:
				throw error(400, `Unknown op "${op}"`);
		}
	} catch (e: any) {
		if (e instanceof RefError) throw error(404, e.message);
		if (e?.status) throw e; // SvelteKit HttpError
		throw error(400, e?.message ?? String(e));
	}
};

/** Plain text → simple HTML: blank lines separate paragraphs, "- " lines become bullets. */
function toHtml(textIn: string): string {
	const t = textIn.replace(/\r\n/g, '\n').trim();
	if (!t) return '';
	if (/^\s*<(p|ul|ol|div|h\d|strong|em)\b/i.test(t)) return t;
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return t.split(/\n{2,}/).map((block) => {
		const lines = block.split('\n');
		if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^\s*[-•*]\s+/, ''))}</li>`).join('')}</ul>`;
		return `<p>${lines.map(esc).join('<br />')}</p>`;
	}).join('');
}
