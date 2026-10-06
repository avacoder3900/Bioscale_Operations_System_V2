import { PartDefinition } from '$lib/server/db/models/index.js';
import { getDeviceAssemblyWI, sectionLabel } from './device-assembly-wi';

// Reference resolution + compact serialisation shared by the /api/agent/device-assembly/**
// endpoints (which back the MCP tools). Humans talk about "step 2 in sub-assembly 2";
// this layer turns that into section numbers and step ids.

export class RefError extends Error {}

export async function requireWI(): Promise<any> {
	const wi = await getDeviceAssemblyWI();
	if (!wi) throw new RefError('No SPU Assembly Work Instruction has been imported yet. Upload the .docx in BIMS (SPU → SPU Assembly WI) or use device_wi_import.');
	return wi;
}

/** "0" | "setup" | "1" | "sub-assembly 2" | "SA3" | "bottom" (title match) → section */
export function resolveSection(wi: any, ref: string | number | null | undefined): any {
	if (ref === null || ref === undefined || ref === '') throw new RefError('section is required (e.g. 2, "sub-assembly 2", or "setup")');
	const sections: any[] = wi.sections;
	if (typeof ref === 'number') {
		const hit = sections.find((s) => s.number === ref);
		if (!hit) throw new RefError(`No section number ${ref}. Available: ${sections.map((s) => `${s.number} = ${sectionLabel(s)} (${s.title})`).join('; ')}`);
		return hit;
	}
	const text = String(ref).trim().toLowerCase();
	if (/^(setup|set-up|cleaning|cleaning and setup|prep)$/.test(text)) {
		const hit = sections.find((s) => s.type === 'setup');
		if (hit) return hit;
	}
	const m = /(?:sub-?\s*assembly|sa|section|#)?\s*#?\s*(\d+)\s*$/i.exec(text);
	if (m) {
		const n = Number(m[1]);
		const hit = sections.find((s) => s.number === n);
		if (hit) return hit;
	}
	const byTitle = sections.filter((s) => (s.title ?? '').toLowerCase().includes(text));
	if (byTitle.length === 1) return byTitle[0];
	if (byTitle.length > 1) throw new RefError(`"${ref}" matches several sections: ${byTitle.map((s) => `${sectionLabel(s)} (${s.title})`).join('; ')}`);
	throw new RefError(`Section "${ref}" not found. Available: ${sections.map((s) => `${s.number} = ${sectionLabel(s)} (${s.title})`).join('; ')}`);
}

/** Step by id, or by number within a section, or by title/text match within a section. */
export function resolveStep(wi: any, sectionRef: string | number | null | undefined, stepRef: string | number | null | undefined): { section: any; step: any } {
	if (typeof stepRef === 'string' && /^[A-Za-z0-9_-]{15,}$/.test(stepRef) && !/^\d+$/.test(stepRef)) {
		for (const s of wi.sections) {
			const st = s.steps.find((x: any) => x._id === stepRef);
			if (st) return { section: s, step: st };
		}
		throw new RefError(`No step with id ${stepRef}`);
	}
	const section = resolveSection(wi, sectionRef);
	if (stepRef === null || stepRef === undefined || stepRef === '') throw new RefError('step is required (a step number within the section, or a step id)');
	const n = typeof stepRef === 'number' ? stepRef : Number(String(stepRef).replace(/^step\s*/i, '').trim());
	if (Number.isFinite(n)) {
		const step = section.steps.find((x: any) => x.stepNumber === n);
		if (!step) throw new RefError(`${sectionLabel(section)} has ${section.steps.length} steps — there is no step ${n}`);
		return { section, step };
	}
	const text = String(stepRef).toLowerCase();
	const hits = section.steps.filter((x: any) => (x.title ?? '').toLowerCase().includes(text) || (x.instructionsText ?? '').toLowerCase().includes(text));
	if (hits.length === 1) return { section, step: hits[0] };
	if (hits.length > 1) throw new RefError(`"${stepRef}" matches ${hits.length} steps in ${sectionLabel(section)}: ${hits.map((x: any) => `step ${x.stepNumber} (${x.title})`).join('; ')}`);
	throw new RefError(`No step matching "${stepRef}" in ${sectionLabel(section)}`);
}

/** Material by id, part number, or name within a step. */
export function resolveMaterial(step: any, ref: string): any {
	const r = ref.trim();
	let hit = step.materials.find((m: any) => m._id === r);
	if (hit) return hit;
	const upper = r.toUpperCase();
	hit = step.materials.find((m: any) => (m.partNumber ?? '').toUpperCase() === upper);
	if (hit) return hit;
	const lower = r.toLowerCase();
	const byName = step.materials.filter((m: any) => (m.name ?? '').toLowerCase().includes(lower));
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) throw new RefError(`"${ref}" matches several materials on step ${step.stepNumber}: ${byName.map((m: any) => `${m.name}${m.partNumber ? ` (${m.partNumber})` : ''}`).join('; ')}`);
	throw new RefError(`Material "${ref}" is not on step ${step.stepNumber}. Materials: ${step.materials.map((m: any) => `${m.name}${m.partNumber ? ` (${m.partNumber})` : ''}`).join('; ') || 'none'}`);
}

export function resolveImage(step: any, ref: string | number): { image: any; position: number } {
	const images: any[] = step.images ?? [];
	if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
		const pos = Number(ref);
		if (pos < 1 || pos > images.length) throw new RefError(`Step ${step.stepNumber} has ${images.length} image(s) — there is no image ${pos}`);
		return { image: images[pos - 1], position: pos };
	}
	const idx = images.findIndex((im) => im._id === ref || im.url === ref);
	if (idx < 0) throw new RefError(`Image "${ref}" is not on step ${step.stepNumber}`);
	return { image: images[idx], position: idx + 1 };
}

export async function stockIndex(wi: any): Promise<Record<string, { inventoryCount: number; partNumber: string; name: string }>> {
	const ids = new Set<string>();
	for (const s of wi.sections) for (const st of s.steps) for (const m of st.materials) if (m.partDefinitionId) ids.add(m.partDefinitionId);
	const out: Record<string, any> = {};
	if (!ids.size) return out;
	const parts = await PartDefinition.find({ _id: { $in: [...ids] } }).select('partNumber name inventoryCount').lean();
	for (const p of parts as any[]) out[String(p._id)] = { inventoryCount: p.inventoryCount ?? 0, partNumber: p.partNumber, name: p.name };
	return out;
}

export function materialView(m: any, stock: Record<string, any>) {
	const s = m.partDefinitionId ? stock[m.partDefinitionId] : null;
	return {
		materialId: m._id,
		kind: m.kind,
		partNumber: m.partNumber,
		name: m.name,
		quantityPerDevice: m.quantity,
		unit: m.unit,
		deductFromInventory: m.deductFromInventory,
		linkedToCatalog: Boolean(m.partDefinitionId),
		onHand: s ? s.inventoryCount : null,
		notes: m.notes || undefined
	};
}

export function stepView(section: any, step: any, stock: Record<string, any>, opts: { full?: boolean } = {}) {
	const base = {
		stepId: step._id,
		section: sectionLabel(section),
		sectionNumber: section.number,
		stepNumber: step.stepNumber,
		ref: `step ${step.stepNumber} in ${sectionLabel(section)}`,
		title: step.title,
		requiresEsd: Boolean(step.requiresEsd),
		dhrFields: step.dhrFields ?? [],
		imageCount: step.images?.length ?? 0,
		materialCount: step.materials?.length ?? 0
	};
	if (!opts.full) return base;
	return {
		...base,
		instructionsText: step.instructionsText,
		instructionsHtml: step.instructionsHtml,
		images: (step.images ?? []).map((im: any, i: number) => ({ position: i + 1, imageId: im._id, url: im.url, caption: im.caption || undefined, alt: im.alt || undefined, addedBy: im.addedBy, addedAt: im.addedAt })),
		materials: (step.materials ?? []).map((m: any) => materialView(m, stock))
	};
}

export function overview(wi: any, stock: Record<string, any>) {
	const unresolved = new Set<string>();
	for (const s of wi.sections) for (const st of s.steps) for (const m of st.materials) if (m.kind === 'part' && !m.partDefinitionId) unresolved.add(m.partNumber ?? m.name);
	return {
		documentNumber: wi.documentNumber,
		title: wi.title,
		assemblyNumber: wi.assemblyNumber,
		status: wi.status,
		version: wi.currentVersion,
		versionLabel: `v${wi.currentVersion}`,
		lastChangedBy: wi.lastChangedBy?.username ?? null,
		lastChangedAt: wi.lastChangedAt,
		sourceFile: wi.sourceFile?.originalFileName ?? null,
		pageUrl: '/spu/assembly-wi',
		frontMatter: {
			purpose: htmlToText(wi.frontMatter?.purposeHtml),
			scope: htmlToText(wi.frontMatter?.scopeHtml),
			responsibilities: htmlToText(wi.frontMatter?.responsibilitiesHtml),
			definitions: wi.frontMatter?.definitions ?? [],
			references: wi.frontMatter?.references ?? [],
			generalNotes: htmlToText(wi.frontMatter?.generalNotesHtml)
		},
		sections: wi.sections.map((s: any) => ({
			sectionNumber: s.number,
			label: sectionLabel(s),
			type: s.type,
			title: s.title,
			stepCount: s.steps.length,
			steps: s.steps.map((st: any) => stepView(s, st, stock))
		})),
		partsNotInCatalog: [...unresolved],
		recentRevisions: [...wi.revisions].sort((a: any, b: any) => b.version - a.version).slice(0, 5).map(revisionView)
	};
}

function htmlToText(html: string | null | undefined): string {
	return (html ?? '').replace(/<\/(p|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function revisionView(r: any) {
	return {
		version: r.version,
		label: r.label,
		changeType: r.changeType,
		summary: r.summary,
		where: r.location?.sectionNumber != null ? `${r.location.sectionNumber === 0 ? 'Setup' : `Sub-Assembly ${r.location.sectionNumber}`}${r.location.stepNumber != null ? ` · step ${r.location.stepNumber}` : ''}` : null,
		changedBy: r.changedBy?.username ?? null,
		changedAt: r.changedAt,
		before: r.before ?? undefined,
		after: r.after ?? undefined
	};
}

const IMAGE_FETCH_LIMIT = 15 * 1024 * 1024;

/** Fetch an image from a URL or decode base64 → buffer + content type. */
export async function loadImageInput(input: { imageUrl?: string; imageBase64?: string; contentType?: string }, fetcher: typeof fetch): Promise<{ buf: Buffer; contentType: string; name: string }> {
	if (input.imageBase64) {
		const m = /^data:([^;]+);base64,(.*)$/s.exec(input.imageBase64);
		const b64 = m ? m[2] : input.imageBase64;
		const ct = m ? m[1] : input.contentType;
		if (!ct || !ct.startsWith('image/')) throw new RefError('contentType (e.g. image/png) is required with imageBase64');
		const buf = Buffer.from(b64, 'base64');
		if (!buf.length) throw new RefError('imageBase64 decoded to zero bytes');
		if (buf.length > IMAGE_FETCH_LIMIT) throw new RefError('Image is larger than 15 MB');
		return { buf, contentType: ct, name: 'upload' };
	}
	if (input.imageUrl) {
		let url: URL;
		try { url = new URL(input.imageUrl); } catch { throw new RefError(`imageUrl is not a valid URL: ${input.imageUrl}`); }
		if (!/^https?:$/.test(url.protocol)) throw new RefError('imageUrl must be http(s)');
		const res = await fetcher(url.toString());
		if (!res.ok) throw new RefError(`Could not fetch image (${res.status}) from ${url}`);
		const ct = (res.headers.get('content-type') || '').split(';')[0].trim() || input.contentType || '';
		if (!ct.startsWith('image/')) throw new RefError(`URL did not return an image (content-type ${ct || 'unknown'})`);
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > IMAGE_FETCH_LIMIT) throw new RefError('Image is larger than 15 MB');
		return { buf, contentType: ct, name: url.pathname.split('/').pop() || 'image' };
	}
	throw new RefError('Provide imageUrl or imageBase64');
}
