import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, User, NotificationSettings, AuditLog, generateId } from '$lib/server/db';
import { sendEmail, renderEmailHtml } from '$lib/server/email';
import type { Actions, PageServerLoad } from './$types';

const NOTIFICATION_TYPES = [
	'temperatureAlerts',
	'lowWaxBatch',
	'lowInventory',
	'runComplete',
	'runAborted',
	'equipmentOffline',
	'dailyDigest',
	'adminEvents'
] as const;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'admin:full');
	await connectDB();

	const [users, settings] = await Promise.all([
		User.find({ isActive: true, email: { $exists: true, $ne: null } })
			.select('_id username email firstName lastName')
			.sort({ username: 1 })
			.lean() as Promise<any[]>,
		NotificationSettings.findById('default').lean() as Promise<any>
	]);

	const s = settings ?? {};
	const enabled = s.enabled ?? {};

	return {
		users: users.map(u => ({
			id: String(u._id),
			username: u.username,
			email: u.email,
			displayName: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username
		})),
		settings: {
			temperatureAlerts: s.temperatureAlerts ?? [],
			lowWaxBatch: s.lowWaxBatch ?? [],
			lowInventory: s.lowInventory ?? [],
			runComplete: s.runComplete ?? [],
			runAborted: s.runAborted ?? [],
			equipmentOffline: s.equipmentOffline ?? [],
			dailyDigest: s.dailyDigest ?? [],
			adminEvents: s.adminEvents ?? [],
			enabled: {
				temperatureAlerts: enabled.temperatureAlerts ?? true,
				lowWaxBatch: enabled.lowWaxBatch ?? true,
				lowInventory: enabled.lowInventory ?? true,
				runComplete: enabled.runComplete ?? true,
				runAborted: enabled.runAborted ?? true,
				equipmentOffline: enabled.equipmentOffline ?? true,
				dailyDigest: enabled.dailyDigest ?? true,
				adminEvents: enabled.adminEvents ?? true
			},
			lowWaxBatchThresholdUl: s.lowWaxBatchThresholdUl ?? 1600,
			lowInventoryPercentThreshold: s.lowInventoryPercentThreshold ?? 20
		}
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		requirePermission(locals.user, 'admin:full');
		await connectDB();

		const form = await request.formData();
		const update: Record<string, any> = {};
		const enabled: Record<string, boolean> = {};

		for (const type of NOTIFICATION_TYPES) {
			const raw = form.get(type)?.toString() ?? '';
			const userIds = raw.split(',').map(s => s.trim()).filter(Boolean);
			update[type] = userIds;
			enabled[type] = form.get(`enabled_${type}`) === 'on';
		}
		update.enabled = enabled;

		const lowWax = Number(form.get('lowWaxBatchThresholdUl'));
		const lowInv = Number(form.get('lowInventoryPercentThreshold'));
		if (Number.isFinite(lowWax) && lowWax >= 0) update.lowWaxBatchThresholdUl = lowWax;
		if (Number.isFinite(lowInv) && lowInv >= 0) update.lowInventoryPercentThreshold = lowInv;

		await NotificationSettings.findByIdAndUpdate('default', { $set: update }, { upsert: true });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'notification_settings',
			recordId: 'default',
			action: 'UPDATE',
			changedBy: locals.user!.username,
			changedAt: new Date(),
			newData: update
		});

		return { success: true, message: 'Notification settings saved.' };
	},

	sendTest: async ({ request, locals }) => {
		requirePermission(locals.user, 'admin:full');
		await connectDB();

		const form = await request.formData();
		const email = form.get('email')?.toString().trim();
		if (!email || !email.includes('@')) return fail(400, { testError: 'Valid email required' });

		const result = await sendEmail({
			to: email,
			subject: '[BIMS] Test notification',
			tag: 'admin_test',
			html: renderEmailHtml({
				title: 'Test email',
				preheader: 'Your BIMS notifications are working.',
				bodyHtml: `
					<p>This is a test email from BIMS.</p>
					<p>If you received this, Resend is wired up correctly and your notification system is good to go.</p>
					<p>Sent by <strong>${locals.user!.username}</strong> at ${new Date().toISOString()}.</p>
				`
			})
		});

		if (!result.sent) {
			return fail(500, { testError: result.error ?? `Not sent: ${result.skipped}` });
		}
		return { testSuccess: `Email sent to ${email} (Resend id: ${result.id ?? 'n/a'})` };
	}
};
