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

	const { parameters } = await request.json();
	if (!Array.isArray(parameters)) return json({ error: 'parameters[] required' }, { status: 400 });

	const settings = await ManufacturingSettings.findById('default');
	if (!settings) return json({ error: 'Settings not initialized' }, { status: 400 });

	const oc = settings.opticalConfirmation;
	if (oc?.locked && !isAdmin(locals.user)) return json({ error: 'Criteria locked - admin required to edit' }, { status: 403 });

	const oldParams = oc?.parameters;
	settings.set('opticalConfirmation.parameters', parameters);
	settings.updatedAt = new Date();
	await settings.save();

	await AuditLog.create({
		tableName: 'manufacturing_settings', recordId: 'default', action: 'UPDATE',
		oldData: { opticalConfirmation_parameters: oldParams }, newData: { opticalConfirmation_parameters: parameters },
		changedBy: locals.user._id, changedAt: new Date(), reason: 'Edit optical confirmation criteria'
	});

	return json({ success: true });
};
