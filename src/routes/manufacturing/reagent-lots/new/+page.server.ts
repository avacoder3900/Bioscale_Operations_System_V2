import { fail, redirect } from '@sveltejs/kit';
import {
	connectDB,
	ReagentLot,
	ReagentProtocolTemplate,
	AuditLog,
	generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

async function nextLotBarcode(): Promise<string> {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	const prefix = `RGN-${yyyy}${mm}${dd}-`;
	const latest = await ReagentLot.findOne(
		{ lotBarcode: { $regex: `^${prefix}` } },
		{ lotBarcode: 1 }
	).sort({ lotBarcode: -1 }).lean();
	let seq = 1;
	if (latest?.lotBarcode) {
		const last = parseInt(String(latest.lotBarcode).slice(-4), 10);
		if (!Number.isNaN(last)) seq = last + 1;
	}
	return `${prefix}${String(seq).padStart(4, '0')}`;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const preselectedSlug = url.searchParams.get('template');

	const [templates, candidateLots, defaultLotBarcode] = await Promise.all([
		ReagentProtocolTemplate.find({ status: 'active' })
			.select('_id slug name version category description parameters materials')
			.sort({ category: 1, name: 1 })
			.lean(),
		ReagentLot.find({ status: 'finalized' })
			.select('_id lotBarcode templateName templateSlug finalOutputs')
			.sort({ finalizedAt: -1 })
			.limit(100)
			.lean(),
		nextLotBarcode()
	]);

	return {
		templates: JSON.parse(JSON.stringify(templates)),
		candidateLots: JSON.parse(JSON.stringify(candidateLots)),
		preselectedSlug,
		defaultLotBarcode
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const templateId = data.get('templateId')?.toString();
		let lotBarcode = data.get('lotBarcode')?.toString().trim();
		const parameterValuesJson = data.get('parameterValues')?.toString() ?? '[]';
		const inputLotsJson = data.get('inputLots')?.toString() ?? '[]';

		if (!templateId) {
			return fail(400, { error: 'Pick a protocol to start a lot.' });
		}

		const template = await ReagentProtocolTemplate.findById(templateId).lean();
		if (!template) return fail(400, { error: 'Template not found.' });

		// Auto-fill barcode if blank — operator can edit later. Collision
		// guard: if the typed barcode already exists, fall back to a new
		// auto-generated one so we never reject the operator on duplicates
		// (per "nothing required, nothing locked").
		if (!lotBarcode) lotBarcode = await nextLotBarcode();
		const existing = await ReagentLot.findOne({ lotBarcode }).select('_id').lean();
		if (existing) lotBarcode = await nextLotBarcode();

		let parameterValues: any[] = [];
		let inputLots: any[] = [];
		try {
			parameterValues = JSON.parse(parameterValuesJson);
			inputLots = JSON.parse(inputLotsJson);
		} catch {
			return fail(400, { error: 'Malformed parameter or input lot payload.' });
		}

		const lotId = generateId();
		const now = new Date();
		const tpl = template as any;

		await ReagentLot.create({
			_id: lotId,
			lotBarcode,
			templateId: tpl._id,
			templateSlug: tpl.slug,
			templateName: tpl.name,
			templateVersion: tpl.version,
			operator: { _id: locals.user!._id, username: locals.user!.username },
			startedAt: now,
			status: 'in_progress',
			parameterValues,
			inputLots: inputLots.map((il) => ({ ...il, recordedAt: now })),
			stepEntries: [],
			lotNotes: [],
			flags: []
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'INSERT',
			tableName: 'reagent_lots',
			recordId: lotId,
			changedBy: locals.user!.username,
			changedAt: now,
			newData: { lotBarcode, templateSlug: tpl.slug, templateVersion: tpl.version }
		});

		throw redirect(303, `/manufacturing/reagent-lots/${lotId}`);
	}
};
