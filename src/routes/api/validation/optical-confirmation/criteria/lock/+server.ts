import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, ManufacturingSettings, AuditLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'admin:full');
	await connectDB();

	const { locked } = await request.json();
	if (typeof locked !== 'boolean') return json({ error: 'locked (boolean) required' }, { status: 400 });

	const settings = await ManufacturingSettings.findById('default');
	if (!settings) return json({ error: 'Settings not initialized' }, { status: 400 });

	const oc = settings.opticalConfirmation || {};
	const operator = { _id: locals.user._id, username: locals.user.username };
	const now = new Date();
	const wasLocked = !!oc.locked;

	settings.set('opticalConfirmation.locked', locked);
	settings.set('opticalConfirmation.lockedBy', locked ? operator : undefined);
	settings.set('opticalConfirmation.lockedAt', locked ? now : undefined);
	if (!locked && wasLocked) settings.set('opticalConfirmation.version', (oc.version || 1) + 1);
	settings.updatedAt = now;
	await settings.save();

	await AuditLog.create({
		tableName: 'manufacturing_settings', recordId: 'default', action: 'UPDATE',
		newData: { opticalConfirmation_locked: locked }, changedBy: locals.user._id, changedAt: now,
		reason: locked ? 'Lock optical confirmation criteria' : 'Unlock optical confirmation criteria'
	});

	return json({ success: true });
};
