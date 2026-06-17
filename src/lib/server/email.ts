import { Resend } from 'resend';
import { env } from '$env/dynamic/private';
import { AuditLog, NotificationSettings, User, generateId, connectDB } from '$lib/server/db';

let _resend: Resend | null = null;
function getResend(): Resend | null {
	if (_resend) return _resend;
	if (!env.RESEND_API_KEY) return null;
	_resend = new Resend(env.RESEND_API_KEY);
	return _resend;
}

const DEFAULT_FROM = 'onboarding@resend.dev';

export interface SendEmailArgs {
	to: string | string[];
	subject: string;
	html: string;
	text?: string;
	replyTo?: string;
	tag?: string; // free-form label for audit log (e.g. 'temperature_alert')
}

export interface SendEmailResult {
	sent: boolean;
	skipped?: 'no_api_key' | 'no_recipients';
	id?: string;
	error?: string;
}

/**
 * Low-level send. Always goes through audit log — even skips/errors are logged.
 * Callers should use the higher-level notification helpers when possible.
 */
export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
	const resend = getResend();
	const from = env.RESEND_FROM_ADDRESS || DEFAULT_FROM;
	const toList = Array.isArray(args.to) ? args.to : [args.to];
	const cleanTo = toList.map(t => t.trim()).filter(Boolean);

	await connectDB();

	if (!resend) {
		await logEmail({ args, from, to: cleanTo, status: 'skipped', reason: 'no_api_key' });
		return { sent: false, skipped: 'no_api_key' };
	}
	if (cleanTo.length === 0) {
		await logEmail({ args, from, to: cleanTo, status: 'skipped', reason: 'no_recipients' });
		return { sent: false, skipped: 'no_recipients' };
	}

	try {
		const { data, error } = await resend.emails.send({
			from,
			to: cleanTo,
			subject: args.subject,
			html: args.html,
			text: args.text,
			replyTo: args.replyTo
		});
		if (error) {
			await logEmail({ args, from, to: cleanTo, status: 'error', reason: error.message });
			return { sent: false, error: error.message };
		}
		await logEmail({ args, from, to: cleanTo, status: 'sent', id: data?.id });
		return { sent: true, id: data?.id };
	} catch (err: any) {
		const message = err?.message ?? String(err);
		await logEmail({ args, from, to: cleanTo, status: 'error', reason: message });
		return { sent: false, error: message };
	}
}

async function logEmail(params: {
	args: SendEmailArgs;
	from: string;
	to: string[];
	status: 'sent' | 'skipped' | 'error';
	reason?: string;
	id?: string;
}) {
	try {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'email_notifications',
			recordId: params.id ?? generateId(),
			action: 'INSERT',
			changedBy: 'system',
			changedAt: new Date(),
			newData: {
				from: params.from,
				to: params.to,
				subject: params.args.subject,
				tag: params.args.tag,
				status: params.status,
				reason: params.reason,
				resendId: params.id
			}
		});
	} catch {
		/* never throw from logging */
	}
}

/**
 * Resolve User._id list to unique emails. Silently drops users without email.
 */
export async function resolveRecipientEmails(userIds: string[]): Promise<string[]> {
	if (!userIds || userIds.length === 0) return [];
	await connectDB();
	const users = await User.find({ _id: { $in: userIds } }).select('email').lean() as any[];
	const emails = users.map(u => u.email).filter((e: string) => e && e.includes('@'));
	return [...new Set(emails)];
}

export type NotificationType =
	| 'temperatureAlerts'
	| 'lowWaxBatch'
	| 'lowInventory'
	| 'runComplete'
	| 'runAborted'
	| 'equipmentOffline'
	| 'dailyDigest'
	| 'adminEvents';

/**
 * Look up configured recipients for a notification type and return their emails.
 * Also returns whether the type is enabled in settings.
 */
export async function getNotificationRecipients(type: NotificationType): Promise<{
	enabled: boolean;
	emails: string[];
}> {
	await connectDB();
	const settings = await NotificationSettings.findById('default').lean() as any;
	if (!settings) return { enabled: true, emails: [] }; // default-enabled, empty list
	const enabled = settings.enabled?.[type] ?? true;
	if (!enabled) return { enabled: false, emails: [] };
	const userIds: string[] = settings[type] ?? [];
	const emails = await resolveRecipientEmails(userIds);
	return { enabled, emails };
}

/**
 * Shared wrapper — renders a standard HTML shell around the body content.
 * Keeps all BIMS emails visually consistent.
 */
export function renderEmailHtml(opts: {
	title: string;
	preheader?: string;
	bodyHtml: string;
	ctaText?: string;
	ctaUrl?: string;
}): string {
	const cta = opts.ctaText && opts.ctaUrl
		? `<div style="margin:24px 0;"><a href="${opts.ctaUrl}" style="display:inline-block;padding:12px 24px;background:#06b6d4;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">${opts.ctaText}</a></div>`
		: '';
	return `<!doctype html>
<html><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b1016;color:#e5e7eb;">
	${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;">${opts.preheader}</div>` : ''}
	<div style="max-width:600px;margin:0 auto;padding:32px 24px;">
		<div style="border-bottom:1px solid #1f2937;padding-bottom:16px;margin-bottom:24px;">
			<div style="font-size:12px;color:#9ca3af;letter-spacing:0.1em;text-transform:uppercase;">Bioscale Operations</div>
			<h1 style="margin:8px 0 0;font-size:20px;color:#fff;">${opts.title}</h1>
		</div>
		<div style="font-size:14px;line-height:1.6;">${opts.bodyHtml}</div>
		${cta}
		<div style="margin-top:32px;padding-top:16px;border-top:1px solid #1f2937;font-size:12px;color:#6b7280;">
			This is an automated notification from the Bioscale Internal Management System.
		</div>
	</div>
</body></html>`;
}
