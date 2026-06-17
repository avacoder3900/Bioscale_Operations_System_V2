import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, ManufacturingSettings, AuditLog } from '$lib/server/db';
import { requirePermission, isAdmin } from '$lib/server/permissions';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:admin');
	await connectDB();
	const settings = await ManufacturingSettings.findById('default').lean();
	return json({ opticalConfirmation: settings?.opticalConfirmation ?? null });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:admin');
	await connectDB();

	// Accepts { parameters?, assay? } — update either or both.
	const { parameters, assay } = await request.json();
	if (parameters === undefined && assay === undefined) {
		return json({ error: 'Nothing to update (provide parameters and/or assay)' }, { status: 400 });
	}

	let settings = await ManufacturingSettings.findById('default');
	if (!settings) settings = new ManufacturingSettings({ _id: 'default' });

	const oc = settings.opticalConfirmation;
	const changed: Record<string, unknown> = {};

	if (parameters !== undefined) {
		if (!Array.isArray(parameters)) return json({ error: 'parameters must be an array' }, { status: 400 });
		// The lock guards the threshold range only.
		if (oc?.locked && !isAdmin(locals.user)) return json({ error: 'Criteria locked - admin required to edit' }, { status: 403 });
		settings.set('opticalConfirmation.parameters', parameters);
		changed.parameters = parameters;
	}

	if (assay !== undefined) {
		// assay = { _id, name, skuCode } to set, or null to clear.
		settings.set('opticalConfirmation.assay', assay || undefined);
		changed.assay = assay?.skuCode ?? null;
	}

	settings.markModified('opticalConfirmation');
	settings.updatedAt = new Date();
	await settings.save();

	await AuditLog.create({
		tableName: 'manufacturing_settings', recordId: 'default', action: 'UPDATE',
		newData: { opticalConfirmation: changed },
		changedBy: locals.user._id, changedAt: new Date(), reason: 'Edit optical confirmation settings'
	});

	return json({ success: true });
};
