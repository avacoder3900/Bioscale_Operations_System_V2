import { sendEmail, getNotificationRecipients, renderEmailHtml } from './email';
import { connectDB, NotificationSettings, SensorConfig } from './db';

/**
 * Fire-and-forget — notifications never block the calling action.
 * Wraps each helper in try/catch so email failures don't break business logic.
 */
function safely<T extends (...args: any[]) => Promise<any>>(fn: T): T {
	return (async (...args: any[]) => {
		try {
			return await fn(...args);
		} catch (err) {
			console.error('[NOTIFICATION] failed:', err instanceof Error ? err.message : err);
			return { sent: false, error: String(err) };
		}
	}) as T;
}

// ---------- Temperature alerts ----------

export interface TempAlertPayload {
	sensorId: string;
	sensorName: string;
	alertType: 'high_temp' | 'low_temp' | 'lost_connection';
	threshold?: number | null;
	actualValue?: number | null;
	equipmentId?: string | null;
	equipmentName?: string | null;
	timestamp: Date;
}

export const notifyTemperatureAlert = safely(async (payload: TempAlertPayload) => {
	await connectDB();

	// Start with global notification-settings recipients
	const { enabled, emails: globalEmails } = await getNotificationRecipients('temperatureAlerts');
	if (!enabled) return { sent: false, skipped: 'disabled' as const };

	// Merge in sensor-specific recipients from SensorConfig.emailRecipients (legacy path)
	const sc = await SensorConfig.findById(payload.sensorId).select('emailRecipients').lean() as any;
	const sensorEmails: string[] = (sc?.emailRecipients ?? []).filter((e: string) => e?.includes('@'));
	const emails = [...new Set([...globalEmails, ...sensorEmails])];
	if (emails.length === 0) return { sent: false, skipped: 'no_recipients' as const };

	const eqLabel = payload.equipmentName ? ` (${payload.equipmentName})` : '';
	const typeLabel = payload.alertType === 'high_temp' ? 'HIGH TEMPERATURE'
		: payload.alertType === 'low_temp' ? 'LOW TEMPERATURE'
		: 'LOST CONNECTION';
	const subject = `[BIMS] ${typeLabel} — ${payload.sensorName}${eqLabel}`;

	const rows: string[] = [
		`<tr><td style="padding:4px 8px;color:#9ca3af;">Sensor</td><td style="padding:4px 8px;"><strong>${payload.sensorName}</strong> <span style="font-family:monospace;color:#6b7280;">${payload.sensorId}</span></td></tr>`,
		payload.equipmentName ? `<tr><td style="padding:4px 8px;color:#9ca3af;">Equipment</td><td style="padding:4px 8px;">${payload.equipmentName}</td></tr>` : '',
		payload.alertType !== 'lost_connection' && payload.actualValue != null
			? `<tr><td style="padding:4px 8px;color:#9ca3af;">Reading</td><td style="padding:4px 8px;color:#f87171;"><strong>${payload.actualValue}°C</strong></td></tr>` : '',
		payload.threshold != null
			? `<tr><td style="padding:4px 8px;color:#9ca3af;">Threshold</td><td style="padding:4px 8px;">${payload.threshold}°C</td></tr>` : '',
		`<tr><td style="padding:4px 8px;color:#9ca3af;">At</td><td style="padding:4px 8px;">${payload.timestamp.toISOString()}</td></tr>`
	].filter(Boolean);

	const bodyHtml = `
		<p>A <strong>${typeLabel.toLowerCase()}</strong> alert was triggered.</p>
		<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">${rows.join('')}</table>
		<p>Acknowledge this alert in BIMS to silence further notifications for the same condition.</p>
	`;

	return sendEmail({
		to: emails,
		subject,
		tag: 'temperature_alert',
		html: renderEmailHtml({
			title: typeLabel,
			preheader: `${payload.sensorName}${eqLabel}`,
			bodyHtml,
			ctaText: 'View alerts',
			ctaUrl: `${process.env.BIMS_BASE_URL ?? ''}/equipment/temperature-probes`
		})
	});
});

// ---------- Low wax batch ----------

export const notifyLowWaxBatch = safely(async (batch: {
	_id: string;
	lotNumber: string;
	lotBarcode: string;
	remainingVolumeUl: number;
	initialVolumeUl: number;
}) => {
	const { enabled, emails } = await getNotificationRecipients('lowWaxBatch');
	if (!enabled || emails.length === 0) return { sent: false, skipped: 'no_recipients' as const };

	const percentRemaining = batch.initialVolumeUl > 0
		? Math.round((batch.remainingVolumeUl / batch.initialVolumeUl) * 100)
		: 0;

	return sendEmail({
		to: emails,
		subject: `[BIMS] Low wax batch: ${batch.lotNumber} — ${batch.remainingVolumeUl} μL remaining`,
		tag: 'low_wax_batch',
		html: renderEmailHtml({
			title: 'Low Wax Batch',
			preheader: `${batch.lotNumber} at ${percentRemaining}% remaining`,
			bodyHtml: `
				<p>A wax batch is running low and may not cover upcoming runs.</p>
				<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
					<tr><td style="padding:4px 8px;color:#9ca3af;">Lot</td><td style="padding:4px 8px;"><strong>${batch.lotNumber}</strong></td></tr>
					<tr><td style="padding:4px 8px;color:#9ca3af;">Barcode</td><td style="padding:4px 8px;font-family:monospace;">${batch.lotBarcode}</td></tr>
					<tr><td style="padding:4px 8px;color:#9ca3af;">Remaining</td><td style="padding:4px 8px;color:#f87171;"><strong>${batch.remainingVolumeUl} μL</strong> of ${batch.initialVolumeUl} μL (${percentRemaining}%)</td></tr>
				</table>
				<p>Schedule a new wax creation batch to avoid stockouts.</p>
			`,
			ctaText: 'New wax batch',
			ctaUrl: `${process.env.BIMS_BASE_URL ?? ''}/manufacturing/wax-creation`
		})
	});
});

// ---------- Low inventory ----------

export const notifyLowInventory = safely(async (part: {
	_id: string;
	partNumber: string;
	name: string;
	inventoryCount: number;
	minimumOrderQty?: number;
	unitOfMeasure?: string;
}) => {
	const { enabled, emails } = await getNotificationRecipients('lowInventory');
	if (!enabled || emails.length === 0) return { sent: false, skipped: 'no_recipients' as const };

	return sendEmail({
		to: emails,
		subject: `[BIMS] Low inventory: ${part.partNumber} — ${part.inventoryCount} ${part.unitOfMeasure ?? ''} remaining`.trim(),
		tag: 'low_inventory',
		html: renderEmailHtml({
			title: 'Low Inventory',
			preheader: `${part.partNumber} — ${part.name}`,
			bodyHtml: `
				<p>A part has dropped below its reorder threshold.</p>
				<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">
					<tr><td style="padding:4px 8px;color:#9ca3af;">Part</td><td style="padding:4px 8px;"><strong>${part.partNumber}</strong> — ${part.name}</td></tr>
					<tr><td style="padding:4px 8px;color:#9ca3af;">On hand</td><td style="padding:4px 8px;color:#f87171;"><strong>${part.inventoryCount} ${part.unitOfMeasure ?? ''}</strong></td></tr>
					${part.minimumOrderQty ? `<tr><td style="padding:4px 8px;color:#9ca3af;">Reorder qty</td><td style="padding:4px 8px;">${part.minimumOrderQty}</td></tr>` : ''}
				</table>
			`,
			ctaText: 'Order more',
			ctaUrl: `${process.env.BIMS_BASE_URL ?? ''}/parts/${part._id}`
		})
	});
});

// ---------- Run complete / aborted ----------

export const notifyRunLifecycle = safely(async (payload: {
	runId: string;
	runType: 'wax_filling' | 'reagent_filling';
	status: 'completed' | 'aborted' | 'cancelled';
	operator?: string;
	cartridgeCount?: number;
	robot?: string;
	reason?: string;
}) => {
	const type = payload.status === 'completed' ? 'runComplete' : 'runAborted';
	const { enabled, emails } = await getNotificationRecipients(type);
	if (!enabled || emails.length === 0) return { sent: false, skipped: 'no_recipients' as const };

	const label = payload.runType === 'wax_filling' ? 'Wax filling' : 'Reagent filling';
	const verb = payload.status === 'completed' ? 'completed' : 'aborted';
	const subject = `[BIMS] ${label} run ${verb} — ${payload.runId.slice(0, 8)}`;

	const rows: string[] = [
		`<tr><td style="padding:4px 8px;color:#9ca3af;">Run ID</td><td style="padding:4px 8px;font-family:monospace;">${payload.runId}</td></tr>`,
		payload.robot ? `<tr><td style="padding:4px 8px;color:#9ca3af;">Robot</td><td style="padding:4px 8px;">${payload.robot}</td></tr>` : '',
		payload.operator ? `<tr><td style="padding:4px 8px;color:#9ca3af;">Operator</td><td style="padding:4px 8px;">${payload.operator}</td></tr>` : '',
		payload.cartridgeCount != null ? `<tr><td style="padding:4px 8px;color:#9ca3af;">Cartridges</td><td style="padding:4px 8px;">${payload.cartridgeCount}</td></tr>` : '',
		payload.reason ? `<tr><td style="padding:4px 8px;color:#9ca3af;">Reason</td><td style="padding:4px 8px;color:#f87171;">${payload.reason}</td></tr>` : ''
	].filter(Boolean);

	return sendEmail({
		to: emails,
		subject,
		tag: `run_${payload.status}`,
		html: renderEmailHtml({
			title: `${label} ${verb}`,
			preheader: subject,
			bodyHtml: `
				<p>A manufacturing run has ${verb}.</p>
				<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px;">${rows.join('')}</table>
			`
		})
	});
});

// ---------- Admin events ----------

export const notifyAdminEvent = safely(async (payload: {
	event: 'invite_created' | 'role_changed' | 'login_failed' | 'user_deactivated';
	summary: string;
	detailsHtml?: string;
	actor?: string;
}) => {
	const { enabled, emails } = await getNotificationRecipients('adminEvents');
	if (!enabled || emails.length === 0) return { sent: false, skipped: 'no_recipients' as const };

	return sendEmail({
		to: emails,
		subject: `[BIMS Admin] ${payload.summary}`,
		tag: `admin_${payload.event}`,
		html: renderEmailHtml({
			title: 'Admin event',
			preheader: payload.summary,
			bodyHtml: `
				<p><strong>${payload.summary}</strong></p>
				${payload.actor ? `<p style="color:#9ca3af;">Actor: ${payload.actor}</p>` : ''}
				${payload.detailsHtml ?? ''}
			`
		})
	});
});

// ---------- Threshold checks (helpers the callers use to decide whether to fire) ----------

export async function shouldWarnLowWax(remainingVolumeUl: number): Promise<boolean> {
	await connectDB();
	const s = await NotificationSettings.findById('default').select('lowWaxBatchThresholdUl enabled').lean() as any;
	if (s?.enabled?.lowWaxBatch === false) return false;
	const threshold = s?.lowWaxBatchThresholdUl ?? 1600;
	return remainingVolumeUl <= threshold;
}

export async function shouldWarnLowInventory(params: {
	inventoryCount: number;
	minimumOrderQty?: number;
}): Promise<boolean> {
	await connectDB();
	const s = await NotificationSettings.findById('default').select('lowInventoryPercentThreshold enabled').lean() as any;
	if (s?.enabled?.lowInventory === false) return false;
	const pct = s?.lowInventoryPercentThreshold ?? 20;
	if (!params.minimumOrderQty || params.minimumOrderQty <= 0) return false;
	// Warn when inventory drops below (pct%) above the reorder quantity
	const threshold = params.minimumOrderQty * (1 + pct / 100);
	return params.inventoryCount <= threshold;
}
