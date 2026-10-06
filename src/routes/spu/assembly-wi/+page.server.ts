import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { PartDefinition } from '$lib/server/db/models';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import {
	getDeviceAssemblyWI,
	importDeviceAssemblyWI,
	renameSection,
	updateSectionNotes,
	updateStep,
	addStep,
	deleteStep,
	moveStep,
	addStepImages,
	removeStepImage,
	updateStepImage,
	moveStepImage,
	addMaterial,
	addMaterialFromText,
	updateMaterial,
	removeMaterial,
	relinkAllParts,
	type Actor
} from '$lib/server/services/device-assembly-wi';
import { makeDeviceWiImageStore } from '$lib/server/services/device-assembly-wi-images';
import { pullMaterialsForStep, getRecentPulls } from '$lib/server/services/device-assembly-wi-pulls';
import type { Actions, PageServerLoad } from './$types';

const MAX_DOCX_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const wi = await getDeviceAssemblyWI();
	const canEdit = hasPermission(locals.user, 'spu:write');

	// Live on-hand counts for every linked material, keyed by partDefinitionId.
	const stock: Record<string, { inventoryCount: number; name: string; partNumber: string; unitOfMeasure: string | null }> = {};
	const pullsByStep: Record<string, any[]> = {};
	if (wi) {
		const ids = new Set<string>();
		for (const s of wi.sections) for (const st of s.steps) for (const m of st.materials) if (m.partDefinitionId) ids.add(m.partDefinitionId);
		if (ids.size) {
			const parts = await PartDefinition.find({ _id: { $in: [...ids] } }).select('partNumber name inventoryCount unitOfMeasure').lean();
			for (const p of parts as any[]) stock[String(p._id)] = { inventoryCount: p.inventoryCount ?? 0, name: p.name, partNumber: p.partNumber, unitOfMeasure: p.unitOfMeasure ?? null };
		}
		for (const pull of await getRecentPulls(wi._id, 300)) {
			(pullsByStep[pull.stepId] ??= []).push(pull);
		}
	}

	// Catalog list for linking materials in edit mode (SPU parts first).
	const catalog = canEdit
		? await PartDefinition.find({ isActive: { $ne: false } }).select('partNumber name inventoryCount bomType').sort({ partNumber: 1 }).lean()
		: [];

	const recentRevisions = wi ? [...wi.revisions].sort((a: any, b: any) => b.version - a.version).slice(0, 8) : [];

	return {
		wi,
		canEdit,
		stock,
		pullsByStep,
		recentRevisions,
		catalog: JSON.parse(JSON.stringify(catalog))
	};
};

function actor(locals: App.Locals): Actor {
	return { _id: locals.user!._id, username: locals.user!.username };
}
function num(v: FormDataEntryValue | null, fallback: number | null = null): number | null {
	if (v == null || v === '') return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}
function str(v: FormDataEntryValue | null): string {
	return (v ?? '').toString();
}
async function run(fn: () => Promise<any>, okMessage: (r: any) => string) {
	try {
		const r = await fn();
		return { success: true, message: okMessage(r), version: r?.version ?? null };
	} catch (e: any) {
		return fail(400, { error: e?.message ?? String(e) });
	}
}

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || !file.size) return fail(400, { error: 'Choose a .docx file to import' });
		if (!file.name.toLowerCase().endsWith('.docx')) return fail(400, { error: 'Only .docx files are supported' });
		if (file.size > MAX_DOCX_BYTES) return fail(400, { error: 'File is larger than 40 MB' });
		const buffer = Buffer.from(await file.arrayBuffer());
		const existing = await getDeviceAssemblyWI();
		const store = makeDeviceWiImageStore({ wiId: existing?._id ?? null, uploadedBy: locals.user!.username });
		return run(
			() => importDeviceAssemblyWI({ buffer, mimeType: file.type, originalName: file.name }, actor(locals), store),
			(r) => {
				const steps = r.parsed.sections.reduce((n: number, s: any) => n + s.steps.length, 0);
				const unresolved = r.unresolved.length ? ` ${r.unresolved.length} part number(s) not in catalog: ${r.unresolved.join(', ')}.` : '';
				return `Imported ${file.name} as v${r.version}: ${steps} steps, ${r.parsed.imageCount} images.${unresolved}`;
			}
		);
	},

	renameSection: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const title = str(form.get('title')).trim();
		if (sectionNumber == null || !title) return fail(400, { error: 'Section and title are required' });
		return run(() => renameSection(actor(locals), sectionNumber, title), (r) => `${r.summary} — now ${r.label}`);
	},

	updateSectionNotes: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		if (sectionNumber == null) return fail(400, { error: 'Section is required' });
		return run(() => updateSectionNotes(actor(locals), sectionNumber, str(form.get('notesHtml'))), (r) => `${r.summary} — now ${r.label}`);
	},

	updateStep: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		if (sectionNumber == null || !stepId) return fail(400, { error: 'Step reference missing' });
		const dhr = str(form.get('dhrFields')).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
		return run(
			() => updateStep(actor(locals), sectionNumber, stepId, {
				title: str(form.get('title')),
				instructionsHtml: str(form.get('instructionsHtml')),
				requiresEsd: form.get('requiresEsd') === 'on',
				dhrFields: dhr
			}),
			(r) => `${r.summary} — now ${r.label}`
		);
	},

	addStep: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		if (sectionNumber == null) return fail(400, { error: 'Section is required' });
		const title = str(form.get('title')).trim();
		const instructionsHtml = str(form.get('instructionsHtml'));
		if (!title && !instructionsHtml.trim()) return fail(400, { error: 'Give the step a title or instructions' });
		return run(
			() => addStep(actor(locals), sectionNumber, { title, instructionsHtml, afterStepId: str(form.get('afterStepId')) || null, requiresEsd: form.get('requiresEsd') === 'on' }),
			(r) => `${r.summary} — now ${r.label}`
		);
	},

	deleteStep: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		if (sectionNumber == null || !stepId) return fail(400, { error: 'Step reference missing' });
		return run(() => deleteStep(actor(locals), sectionNumber, stepId), (r) => `${r.summary} — now ${r.label}`);
	},

	moveStep: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const fromSection = num(form.get('sectionNumber'));
		const toSection = num(form.get('toSection'));
		const stepId = str(form.get('stepId'));
		if (fromSection == null || toSection == null || !stepId) return fail(400, { error: 'Step reference missing' });
		return run(() => moveStep(actor(locals), fromSection, stepId, toSection, num(form.get('toPosition'))), (r) => `${r.summary} — now ${r.label}`);
	},

	addImages: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		if (sectionNumber == null || !stepId) return fail(400, { error: 'Step reference missing' });
		const files = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
		if (!files.length) return fail(400, { error: 'Choose at least one image' });
		for (const f of files) {
			if (!f.type.startsWith('image/')) return fail(400, { error: `${f.name} is not an image` });
			if (f.size > MAX_IMAGE_BYTES) return fail(400, { error: `${f.name} is larger than 15 MB` });
		}
		const wi = await getDeviceAssemblyWI();
		if (!wi) return fail(400, { error: 'Import the work instruction first' });
		const store = makeDeviceWiImageStore({ wiId: wi._id, uploadedBy: locals.user!.username, keyPrefix: `device-wi/${wi._id}/step-${stepId}/${Date.now()}` });
		const caption = str(form.get('caption')).trim();
		try {
			const stored = [];
			let i = 0;
			for (const f of files) {
				const s = await store(Buffer.from(await f.arrayBuffer()), f.type, ++i);
				stored.push({ url: s.url, storage: s.storage, alt: f.name.replace(/\.[a-z0-9]+$/i, ''), caption: files.length === 1 ? caption : '' });
			}
			const r = await addStepImages(actor(locals), sectionNumber, stepId, stored);
			return { success: true, message: `${r.summary} — now ${r.label}`, version: r.version };
		} catch (e: any) {
			return fail(400, { error: e?.message ?? String(e) });
		}
	},

	removeImage: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		const imageId = str(form.get('imageId'));
		if (sectionNumber == null || !stepId || !imageId) return fail(400, { error: 'Image reference missing' });
		return run(() => removeStepImage(actor(locals), sectionNumber, stepId, imageId), (r) => `${r.summary} — now ${r.label}`);
	},

	updateImage: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		const imageId = str(form.get('imageId'));
		if (sectionNumber == null || !stepId || !imageId) return fail(400, { error: 'Image reference missing' });
		const direction = str(form.get('direction'));
		if (direction === 'up' || direction === 'down') {
			return run(() => moveStepImage(actor(locals), sectionNumber, stepId, imageId, direction), (r) => `${r.summary} — now ${r.label}`);
		}
		return run(() => updateStepImage(actor(locals), sectionNumber, stepId, imageId, { caption: str(form.get('caption')) }), (r) => `${r.summary} — now ${r.label}`);
	},

	addMaterial: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		if (sectionNumber == null || !stepId) return fail(400, { error: 'Step reference missing' });
		const text = str(form.get('text')).trim();
		if (text) return run(() => addMaterialFromText(actor(locals), sectionNumber, stepId, text), (r) => `${r.summary} — now ${r.label}`);
		const name = str(form.get('name')).trim();
		const kind = str(form.get('kind')) as any;
		const quantity = num(form.get('quantity'), 1)!;
		if (!name) return fail(400, { error: 'Material name is required' });
		if (!['part', 'tool', 'aid', 'supply'].includes(kind)) return fail(400, { error: 'Invalid material kind' });
		if (!(quantity > 0)) return fail(400, { error: 'Quantity must be greater than 0' });
		return run(
			() => addMaterial(actor(locals), sectionNumber, stepId, { kind, name, quantity, unit: str(form.get('unit')) || 'ea', partNumber: str(form.get('partNumber')) || null, notes: str(form.get('notes')) }),
			(r) => `${r.summary} — now ${r.label}`
		);
	},

	updateMaterial: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		const materialId = str(form.get('materialId'));
		if (sectionNumber == null || !stepId || !materialId) return fail(400, { error: 'Material reference missing' });
		const patch: any = {};
		if (form.has('name')) patch.name = str(form.get('name'));
		if (form.has('quantity')) { const q = num(form.get('quantity')); if (!(q != null && q > 0)) return fail(400, { error: 'Quantity must be greater than 0' }); patch.quantity = q; }
		if (form.has('unit')) patch.unit = str(form.get('unit'));
		if (form.has('kind')) patch.kind = str(form.get('kind'));
		if (form.has('partNumber')) patch.partNumber = str(form.get('partNumber')) || null;
		if (form.has('notes')) patch.notes = str(form.get('notes'));
		if (form.has('deductFromInventory')) patch.deductFromInventory = form.get('deductFromInventory') === 'on';
		return run(() => updateMaterial(actor(locals), sectionNumber, stepId, materialId, patch), (r) => `${r.summary} — now ${r.label}`);
	},

	removeMaterial: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		const materialId = str(form.get('materialId'));
		if (sectionNumber == null || !stepId || !materialId) return fail(400, { error: 'Material reference missing' });
		return run(() => removeMaterial(actor(locals), sectionNumber, stepId, materialId), (r) => `${r.summary} — now ${r.label}`);
	},

	relinkParts: async ({ locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		return run(() => relinkAllParts(actor(locals)), (r) => `${r.summary} — now ${r.label}`);
	},

	// Deduct the selected materials for a step from inventory.
	// Form fields: sectionNumber, stepId, unitsBuilt, deviceSerial, notes,
	// and for each material row: pull_<materialId>=on + qty_<materialId>=<number>.
	pullMaterials: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sectionNumber = num(form.get('sectionNumber'));
		const stepId = str(form.get('stepId'));
		if (sectionNumber == null || !stepId) return fail(400, { error: 'Step reference missing' });
		const items: { materialId: string; quantity: number }[] = [];
		for (const [key, value] of form.entries()) {
			if (!key.startsWith('pull_') || value !== 'on') continue;
			const materialId = key.slice('pull_'.length);
			const quantity = num(form.get(`qty_${materialId}`), 0) ?? 0;
			items.push({ materialId, quantity });
		}
		if (!items.length) return fail(400, { error: 'Tick at least one material to pull' });
		return run(
			() => pullMaterialsForStep({ sectionNumber, stepId, items, unitsBuilt: num(form.get('unitsBuilt'), 1) ?? 1, deviceSerial: str(form.get('deviceSerial')), notes: str(form.get('notes')) }, actor(locals)),
			(r) => `Pulled ${r.results.length} material${r.results.length === 1 ? '' : 's'} for step ${r.stepNumber}: ` + r.results.map((x: any) => `${x.partNumber ?? x.name} −${x.quantity} (${x.previousQuantity} → ${x.newQuantity})`).join(', ')
		);
	}
};

export const config = { maxDuration: 120 };
