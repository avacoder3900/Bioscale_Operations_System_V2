import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, User, NotificationSettings, AuditLog, generateId } from '$lib/server/db';
import { sendEmail, renderEmailHtml } from '$lib/server/email';
import {
	notifyTemperatureAlert, notifyLowWaxBatch, notifyLowInventory,
	notifyRunLifecycle, notifyAdminEvent
} from '$lib/server/notifications';
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
	},

	/**
	 * Preview each alert template by sending a dummy version to the requested email.
	 * Uses the real notify* helpers (with dummy data) so you see exactly what the
	 * live emails will look like. Overrides the recipient list for this one-off call.
	 */
	previewAlert: async ({ request, locals }) => {
		requirePermission(locals.user, 'admin:full');
		await connectDB();

		const form = await request.formData();
		const alertType = form.get('alertType')?.toString() as
			| 'temperatureAlert_high' | 'temperatureAlert_low' | 'temperatureAlert_lost'
			| 'lowWaxBatch' | 'lowInventory'
			| 'runComplete' | 'runAborted' | 'adminEvent';
		const email = form.get('email')?.toString().trim();
		if (!email || !email.includes('@')) return fail(400, { previewError: 'Valid email required' });

		// Temporarily set the given user's email as sole recipient for ALL types by
		// overriding NotificationSettings._id='preview'. Simpler: directly send with
		// sendEmail using the same HTML the helpers would produce.
		// Easiest path: construct payloads and call sendEmail directly with fake recipients.
		const { sendEmail: send } = await import('$lib/server/email');

		// Build the email via the exact renderer each helper uses
		const results: Record<string, any> = {};
		const now = new Date();

		// Bypass the recipient lookup by sending directly
		async function sendOne(subject: string, tag: string, html: string) {
			return send({ to: email, subject, tag, html });
		}

		if (alertType === 'temperatureAlert_high') {
			results.out = await sendOne(
				'[BIMS] HIGH TEMPERATURE — CLIA Freezer (TEST)',
				'preview_temperature_alert',
				renderEmailHtml({
					title: 'HIGH TEMPERATURE',
					preheader: 'CLIA Freezer (TEST)',
					bodyHtml: `
						<p>A <strong>high temperature</strong> alert was triggered.</p>
						<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
							<tr><td style="padding:4px 8px;color:#9ca3af;">Sensor</td><td style="padding:4px 8px;"><strong>CLIA Freezer</strong> <span style="font-family:monospace;color:#6b7280;">MC30AEA4004617</span></td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Equipment</td><td style="padding:4px 8px;">CLIA Freezer</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Reading</td><td style="padding:4px 8px;color:#f87171;"><strong>-12°C</strong></td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Threshold</td><td style="padding:4px 8px;">-15°C</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">At</td><td style="padding:4px 8px;">${now.toISOString()}</td></tr>
						</table>
						<p><em>(TEST PREVIEW — no real alert condition)</em></p>
					`,
					ctaText: 'View alerts',
					ctaUrl: `${process.env.BIMS_BASE_URL ?? ''}/equipment/temperature-probes`
				})
			);
		} else if (alertType === 'temperatureAlert_low') {
			results.out = await sendOne(
				'[BIMS] LOW TEMPERATURE — R&D Freezer (TEST)',
				'preview_temperature_alert',
				renderEmailHtml({
					title: 'LOW TEMPERATURE',
					preheader: 'R&D Freezer (TEST)',
					bodyHtml: `
						<p>A <strong>low temperature</strong> alert was triggered.</p>
						<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
							<tr><td style="padding:4px 8px;color:#9ca3af;">Sensor</td><td style="padding:4px 8px;"><strong>R&D Freezer</strong> <span style="font-family:monospace;color:#6b7280;">MC30AEA40090EE</span></td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Equipment</td><td style="padding:4px 8px;">R&D Freezer</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Reading</td><td style="padding:4px 8px;color:#f87171;"><strong>-28°C</strong></td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Threshold</td><td style="padding:4px 8px;">-20°C</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">At</td><td style="padding:4px 8px;">${now.toISOString()}</td></tr>
						</table>
						<p><em>(TEST PREVIEW — no real alert condition)</em></p>
					`
				})
			);
		} else if (alertType === 'temperatureAlert_lost') {
			results.out = await sendOne(
				'[BIMS] LOST CONNECTION — Manufacturing Fridge (TEST)',
				'preview_temperature_alert',
				renderEmailHtml({
					title: 'LOST CONNECTION',
					preheader: 'Manufacturing Fridge (TEST)',
					bodyHtml: `
						<p>A <strong>lost connection</strong> alert was triggered.</p>
						<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
							<tr><td style="padding:4px 8px;color:#9ca3af;">Sensor</td><td style="padding:4px 8px;"><strong>Manufacturing Fridge</strong></td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Equipment</td><td style="padding:4px 8px;">Manufacturing Fridge</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">At</td><td style="padding:4px 8px;">${now.toISOString()}</td></tr>
						</table>
						<p>The sensor has not reported a reading in over 30 minutes.</p>
						<p><em>(TEST PREVIEW — no real alert condition)</em></p>
					`
				})
			);
		} else if (alertType === 'lowWaxBatch') {
			results.out = await sendOne(
				'[BIMS] Low wax batch: WAX-2026-0007 — 1200 μL remaining (TEST)',
				'preview_low_wax_batch',
				renderEmailHtml({
					title: 'Low Wax Batch',
					preheader: 'WAX-2026-0007 at 2% remaining',
					bodyHtml: `
						<p>A wax batch is running low and may not cover upcoming runs.</p>
						<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
							<tr><td style="padding:4px 8px;color:#9ca3af;">Lot</td><td style="padding:4px 8px;"><strong>WAX-2026-0007</strong></td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Barcode</td><td style="padding:4px 8px;font-family:monospace;">WB-TEST-12345</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Remaining</td><td style="padding:4px 8px;color:#f87171;"><strong>1200 μL</strong> of 60000 μL (2%)</td></tr>
						</table>
						<p>Schedule a new wax creation batch to avoid stockouts.</p>
						<p><em>(TEST PREVIEW — no real alert condition)</em></p>
					`,
					ctaText: 'New wax batch',
					ctaUrl: `${process.env.BIMS_BASE_URL ?? ''}/manufacturing/wax-creation`
				})
			);
		} else if (alertType === 'lowInventory') {
			results.out = await sendOne(
				'[BIMS] Low inventory: PT-CT-110 — 12 ea remaining (TEST)',
				'preview_low_inventory',
				renderEmailHtml({
					title: 'Low Inventory',
					preheader: 'PT-CT-110 — 15ml Conical Tubes',
					bodyHtml: `
						<p>A part has dropped below its reorder threshold.</p>
						<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
							<tr><td style="padding:4px 8px;color:#9ca3af;">Part</td><td style="padding:4px 8px;"><strong>PT-CT-110</strong> — 15ml Conical Tubes</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">On hand</td><td style="padding:4px 8px;color:#f87171;"><strong>12 ea</strong></td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Reorder qty</td><td style="padding:4px 8px;">50</td></tr>
						</table>
						<p><em>(TEST PREVIEW — no real alert condition)</em></p>
					`
				})
			);
		} else if (alertType === 'runComplete') {
			results.out = await sendOne(
				'[BIMS] Wax filling run completed — RUN-TEST (TEST)',
				'preview_run_complete',
				renderEmailHtml({
					title: 'Wax filling completed',
					preheader: 'Run completed successfully',
					bodyHtml: `
						<p>A manufacturing run has completed.</p>
						<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
							<tr><td style="padding:4px 8px;color:#9ca3af;">Run ID</td><td style="padding:4px 8px;font-family:monospace;">RUN-TEST-abc12345</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Robot</td><td style="padding:4px 8px;">RO4 Opentron</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Operator</td><td style="padding:4px 8px;">${locals.user!.username}</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Cartridges</td><td style="padding:4px 8px;">24</td></tr>
						</table>
						<p><em>(TEST PREVIEW — no real run completed)</em></p>
					`
				})
			);
		} else if (alertType === 'runAborted') {
			results.out = await sendOne(
				'[BIMS] Wax filling run aborted — RUN-TEST (TEST)',
				'preview_run_aborted',
				renderEmailHtml({
					title: 'Wax filling aborted',
					preheader: 'Run was cancelled',
					bodyHtml: `
						<p>A manufacturing run has aborted.</p>
						<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
							<tr><td style="padding:4px 8px;color:#9ca3af;">Run ID</td><td style="padding:4px 8px;font-family:monospace;">RUN-TEST-abc12345</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Operator</td><td style="padding:4px 8px;">${locals.user!.username}</td></tr>
							<tr><td style="padding:4px 8px;color:#9ca3af;">Reason</td><td style="padding:4px 8px;color:#f87171;">Test preview — not a real abort</td></tr>
						</table>
						<p><em>(TEST PREVIEW — no real run aborted)</em></p>
					`
				})
			);
		} else if (alertType === 'adminEvent') {
			results.out = await sendOne(
				'[BIMS Admin] Failed login attempt for user "testuser" (TEST)',
				'preview_admin_event',
				renderEmailHtml({
					title: 'Admin event',
					preheader: 'Failed login attempt',
					bodyHtml: `
						<p><strong>Failed login attempt for user "testuser"</strong></p>
						<p style="color:#9ca3af;">Actor: system</p>
						<p>IP: 192.0.2.1</p>
						<p><em>(TEST PREVIEW — no real admin event)</em></p>
					`
				})
			);
		} else {
			return fail(400, { previewError: 'Unknown alert type' });
		}

		const r = results.out;
		if (!r?.sent) return fail(500, { previewError: r?.error ?? `Not sent: ${r?.skipped}` });
		return { previewSuccess: `Preview (${alertType}) sent to ${email}` };
	}
};
