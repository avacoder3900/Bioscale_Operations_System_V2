/**
 * Daily 4:30 PM CDT (21:30 UTC) reminder to ncox@brevitest.com to audit
 * physical fridge + oven cartridge counts against what BIMS reports and
 * reconcile any drift. Schedule: 30 21 * * * (vercel.json).
 *
 * Hard-coded recipient — by design, per operator request. If this needs to
 * grow into a multi-recipient or settings-driven flow later, route it through
 * NotificationSettings + getNotificationRecipients() like daily-digest does.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { sendEmail, renderEmailHtml } from '$lib/server/email';
import type { RequestHandler } from './$types';

const RECIPIENT = 'ncox@brevitest.com';

function authenticate(request: Request): void {
	// CRON_SECRET Bearer (Vercel sends it automatically when the env var is set)
	// or the agent API key. No user-agent fallback — that header is forgeable.
	const auth = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && auth === env.CRON_SECRET) return;
	requireAgentApiKey(request);
}

async function runReminder(request: Request) {
	authenticate(request);

	const now = new Date();
	const subject = `[BIMS] Cartridge cleanup reminder — ${now.toISOString().slice(0, 10)}`;

	const bodyHtml = `
		<p><strong>Daily 4:30 PM nudge:</strong> physical cartridge counts in fridges and ovens have drifted from what BIMS reports. Reconcile before tomorrow's production.</p>

		<h2 style="color:#fff;font-size:16px;margin-top:24px;">Quick checklist</h2>
		<ol style="padding-left:18px;line-height:1.6;">
			<li><strong>Each fridge</strong> — count cartridges physically present, compare to <a href="${env.BIMS_BASE_URL ?? ''}/equipment/activity" style="color:#60a5fa;">Equipment Activity</a> and <a href="${env.BIMS_BASE_URL ?? ''}/inventory/fridge-storage" style="color:#60a5fa;">Fridge Storage</a> (split: wax_accepted / wax_scrapped / reagent).</li>
			<li><strong>Each oven</strong> — count cartridges in each backing-lot bucket, compare to <a href="${env.BIMS_BASE_URL ?? ''}/manufacturing/cart-mfg/pipeline?stage=backing" style="color:#60a5fa;">Pipeline → Backing</a>.</li>
			<li><strong>Adjust deltas</strong> — backing-lot fixes via <a href="${env.BIMS_BASE_URL ?? ''}/manufacturing/cart-mfg/scrap" style="color:#60a5fa;">Cartridge Checkout</a> (Pre-Wax Removal section); fridge fixes via the wax-stored Checkout section on the same page.</li>
		</ol>

		<p style="color:#9ca3af;font-size:12px;margin-top:24px;">Sent automatically every day at 4:30 PM CDT. To stop, disable the <code>cartridge-cleanup-reminder</code> cron in <code>vercel.json</code>.</p>
	`;

	const result = await sendEmail({
		to: [RECIPIENT],
		subject,
		tag: 'cartridge_cleanup_reminder',
		html: renderEmailHtml({
			title: 'Cartridge cleanup reminder',
			preheader: 'Audit physical fridge + oven counts against BIMS and reconcile.',
			bodyHtml,
			ctaText: 'Open Cartridge Checkout',
			ctaUrl: `${env.BIMS_BASE_URL ?? ''}/manufacturing/cart-mfg/scrap`
		})
	});

	console.log(`[CARTRIDGE CLEANUP REMINDER] sent=${result.sent} recipient=${RECIPIENT}`);
	return json({ success: true, sent: result.sent, recipient: RECIPIENT });
}

export const GET: RequestHandler = ({ request }) => runReminder(request);
export const POST: RequestHandler = ({ request }) => runReminder(request);
