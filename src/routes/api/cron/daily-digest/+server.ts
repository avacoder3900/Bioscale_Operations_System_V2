import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, TemperatureAlert, WaxFillingRun, WaxBatch, PartDefinition, NotificationSettings } from '$lib/server/db';
import { sendEmail, renderEmailHtml, resolveRecipientEmails } from '$lib/server/email';
import type { RequestHandler } from './$types';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function authenticateDigest(request: Request): void {
	const auth = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && auth === env.CRON_SECRET) return;
	requireAgentApiKey(request);
}

/**
 * Daily digest — rolls up the last 24 hours of alerts and events into one
 * email. Runs via Vercel Cron at 13:00 UTC daily (8am EST / 9am EDT). Manual trigger via GET/POST.
 */
async function runDigest(request: Request) {
	authenticateDigest(request);
	await connectDB();

	const settings = await NotificationSettings.findById('default').lean() as any;
	if (settings?.enabled?.dailyDigest === false) {
		return json({ success: true, skipped: 'disabled' });
	}
	const recipientIds: string[] = settings?.dailyDigest ?? [];
	const emails = await resolveRecipientEmails(recipientIds);
	if (emails.length === 0) {
		return json({ success: true, skipped: 'no_recipients' });
	}

	const since = new Date(Date.now() - ONE_DAY_MS);
	const now = new Date();

	const [alerts, runsCompleted, runsAborted, lowBatches, lowParts] = await Promise.all([
		TemperatureAlert.find({ timestamp: { $gte: since } }).sort({ timestamp: -1 }).limit(50).lean() as Promise<any[]>,
		WaxFillingRun.countDocuments({ status: { $in: ['completed', 'Completed'] }, runEndTime: { $gte: since } }),
		WaxFillingRun.countDocuments({ status: { $in: ['aborted', 'Aborted', 'cancelled', 'Cancelled'] }, runEndTime: { $gte: since } }),
		WaxBatch.find({ remainingVolumeUl: { $lte: settings?.lowWaxBatchThresholdUl ?? 1600 } }).sort({ remainingVolumeUl: 1 }).limit(10).lean() as Promise<any[]>,
		PartDefinition.find({
			$expr: {
				$and: [
					{ $gt: ['$minimumOrderQty', 0] },
					{ $lte: ['$inventoryCount', { $multiply: ['$minimumOrderQty', 1 + (settings?.lowInventoryPercentThreshold ?? 20) / 100] }] }
				]
			}
		}).select('partNumber name inventoryCount minimumOrderQty unitOfMeasure').limit(20).lean() as Promise<any[]>
	]);

	const alertsByType = {
		high_temp: alerts.filter(a => a.alertType === 'high_temp'),
		low_temp: alerts.filter(a => a.alertType === 'low_temp'),
		lost_connection: alerts.filter(a => a.alertType === 'lost_connection')
	};

	const tempSection = alerts.length > 0 ? `
		<h2 style="color:#fff;font-size:16px;margin-top:24px;">Temperature alerts (last 24h)</h2>
		<ul style="padding-left:18px;">
			${alertsByType.high_temp.length ? `<li><strong style="color:#f87171;">High temp:</strong> ${alertsByType.high_temp.length}</li>` : ''}
			${alertsByType.low_temp.length ? `<li><strong style="color:#60a5fa;">Low temp:</strong> ${alertsByType.low_temp.length}</li>` : ''}
			${alertsByType.lost_connection.length ? `<li><strong style="color:#fbbf24;">Lost connection:</strong> ${alertsByType.lost_connection.length}</li>` : ''}
		</ul>
		<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:12px;">
			<tr><th align="left" style="padding:4px;color:#9ca3af;">Type</th><th align="left" style="padding:4px;color:#9ca3af;">Sensor</th><th align="left" style="padding:4px;color:#9ca3af;">Reading</th><th align="left" style="padding:4px;color:#9ca3af;">When</th></tr>
			${alerts.slice(0, 15).map(a => `
				<tr>
					<td style="padding:4px;">${a.alertType}</td>
					<td style="padding:4px;">${a.sensorName ?? a.sensorId}</td>
					<td style="padding:4px;">${a.actualValue != null ? a.actualValue + '°C' : '—'}</td>
					<td style="padding:4px;color:#6b7280;">${new Date(a.timestamp).toLocaleString()}</td>
				</tr>`).join('')}
		</table>
	` : '<p style="color:#9ca3af;">No temperature alerts in the last 24 hours.</p>';

	const runsSection = `
		<h2 style="color:#fff;font-size:16px;margin-top:24px;">Manufacturing runs (last 24h)</h2>
		<p>Completed: <strong>${runsCompleted}</strong> &nbsp;·&nbsp; Aborted/Cancelled: <strong style="color:${runsAborted > 0 ? '#f87171' : '#e5e7eb'};">${runsAborted}</strong></p>
	`;

	const waxSection = lowBatches.length > 0 ? `
		<h2 style="color:#fff;font-size:16px;margin-top:24px;">Low wax batches</h2>
		<ul style="padding-left:18px;">
			${lowBatches.map(b => `<li><strong>${b.lotNumber}</strong> — ${b.remainingVolumeUl} μL remaining (${Math.round((b.remainingVolumeUl / b.initialVolumeUl) * 100)}%)</li>`).join('')}
		</ul>
	` : '';

	const partsSection = lowParts.length > 0 ? `
		<h2 style="color:#fff;font-size:16px;margin-top:24px;">Low inventory parts</h2>
		<table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:12px;">
			<tr><th align="left" style="padding:4px;color:#9ca3af;">Part</th><th align="left" style="padding:4px;color:#9ca3af;">On hand</th><th align="left" style="padding:4px;color:#9ca3af;">Reorder qty</th></tr>
			${lowParts.map(p => `
				<tr>
					<td style="padding:4px;"><strong>${p.partNumber}</strong> — ${p.name}</td>
					<td style="padding:4px;color:#f87171;">${p.inventoryCount} ${p.unitOfMeasure ?? ''}</td>
					<td style="padding:4px;">${p.minimumOrderQty ?? '—'}</td>
				</tr>`).join('')}
		</table>
	` : '';

	const bodyHtml = `
		<p>Here's a summary of activity in BIMS over the last 24 hours.</p>
		${tempSection}
		${runsSection}
		${waxSection}
		${partsSection}
	`;

	const result = await sendEmail({
		to: emails,
		subject: `[BIMS] Daily digest — ${now.toISOString().slice(0, 10)}`,
		tag: 'daily_digest',
		html: renderEmailHtml({
			title: 'Daily Digest',
			preheader: `${alerts.length} alerts · ${runsCompleted} runs completed · ${lowBatches.length + lowParts.length} low-stock warnings`,
			bodyHtml,
			ctaText: 'Open BIMS',
			ctaUrl: process.env.BIMS_BASE_URL ?? ''
		})
	});

	return json({
		success: true,
		sent: result.sent,
		recipients: emails.length,
		totals: {
			alerts: alerts.length,
			runsCompleted,
			runsAborted,
			lowBatches: lowBatches.length,
			lowParts: lowParts.length
		}
	});
}

export const GET: RequestHandler = ({ request }) => runDigest(request);
export const POST: RequestHandler = ({ request }) => runDigest(request);
