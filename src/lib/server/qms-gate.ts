/**
 * QMS gate — the single chokepoint every user/role/invite/QMS mutation passes through.
 *
 *   requireQmsGate()  – permission check; when REGULATED, also demands step-up
 *                       re-auth (username + password in the submitted form) and
 *                       records an ElectronicSignature for the action.
 *   writeAudit()      – append an immutable AuditLog entry (ALWAYS, both phases).
 *   guardLastAdmin()  – refuse changes that would leave the system with no admin.
 *   guardNotSelf()    – refuse self-deactivation / self-demotion.
 *
 * Design: in CONFIGURATION mode the gate is a thin permission check (no friction);
 * in REGULATED mode it becomes the full step-up + e-signature regime. Off-by-default
 * so existing behaviour is unchanged until the QMS switch is flipped. See ADMIN-01 PRD.
 */
import { error } from '@sveltejs/kit';
import bcrypt from 'bcryptjs';
import { requirePermission } from '$lib/server/permissions';
import { isRegulated } from '$lib/server/qms';
import { connectDB, AuditLog, ElectronicSignature, User, generateId } from '$lib/server/db';
import type { RequestEvent } from '@sveltejs/kit';

const ADMIN_PERMISSIONS = ['admin:full', 'admin:users'];

type Actor = { _id: string; username: string };

function requireActor(event: RequestEvent): Actor {
	const u = event.locals.user;
	if (!u) throw error(401, 'Not authenticated');
	return { _id: u._id, username: u.username };
}

/** Minimal password policy. Returns an error message, or null if acceptable. */
export function passwordPolicyError(password: string, username?: string): string | null {
	if (!password || password.length < 10) return 'Password must be at least 10 characters.';
	if (username && password.toLowerCase() === username.toLowerCase()) {
		return 'Password must not equal the username.';
	}
	return null;
}

/** Re-run bcrypt against the stored hash for `userId`. */
export async function verifyPassword(userId: string, password: string): Promise<boolean> {
	await connectDB();
	const u = (await User.findById(userId).lean()) as any;
	if (!u?.passwordHash) return false;
	return bcrypt.compare(password, u.passwordHash);
}

/**
 * Gate a mutation.
 *  - Always: caller must hold `opts.permission`.
 *  - When regulated: the form must carry `_reauthUser` + `_reauthPassword` matching
 *    the acting admin; a valid step-up records an ElectronicSignature (meaning = action).
 * Throws (403 / 401) on failure — matches the codebase's throw-based requirePermission.
 * Returns the acting user + current regulated flag for the caller to use.
 */
export async function requireQmsGate(
	event: RequestEvent,
	form: FormData,
	opts: { permission: string; action: string; entityType: string; entityId?: string }
): Promise<{ actor: Actor; regulated: boolean }> {
	const actor = requireActor(event);
	requirePermission(event.locals.user, opts.permission);

	const regulated = await isRegulated();
	if (!regulated) return { actor, regulated };

	// Regulated: demand a fresh step-up re-authentication for this action.
	const reauthUser = form.get('_reauthUser')?.toString().trim();
	const reauthPassword = form.get('_reauthPassword')?.toString();
	if (
		!reauthUser ||
		!reauthPassword ||
		reauthUser !== actor.username ||
		!(await verifyPassword(actor._id, reauthPassword))
	) {
		throw error(
			401,
			`Re-authentication required: re-enter your username and password to "${opts.action}" while the QMS regulated environment is active.`
		);
	}

	await recordSignature(event, {
		entityType: opts.entityType,
		entityId: opts.entityId ?? '',
		meaning: opts.action
	});

	return { actor, regulated };
}

/** Append an immutable AuditLog row. Always called, in both phases. */
export async function writeAudit(
	event: RequestEvent,
	entry: {
		tableName: string;
		recordId: string;
		action: 'INSERT' | 'UPDATE' | 'DELETE';
		oldData?: unknown;
		newData?: unknown;
		changedFields?: unknown;
		reason?: string;
	}
): Promise<void> {
	await connectDB();
	await AuditLog.create({
		_id: generateId(),
		tableName: entry.tableName,
		recordId: entry.recordId,
		action: entry.action,
		oldData: entry.oldData,
		newData: entry.newData,
		changedFields: entry.changedFields,
		reason: entry.reason,
		changedAt: new Date(),
		changedBy: event.locals.user?._id ?? 'system',
		sessionId: event.locals.session?._id,
		ipAddress: tryClientAddress(event),
		userAgent: event.request.headers.get('user-agent') ?? undefined
	});
}

/** Capture an electronic signature (the regulated step-up IS the signature). */
export async function recordSignature(
	event: RequestEvent,
	sig: { entityType: string; entityId: string; meaning: string }
): Promise<void> {
	await connectDB();
	await ElectronicSignature.create({
		_id: generateId(),
		userId: event.locals.user?._id,
		entityType: sig.entityType,
		entityId: sig.entityId,
		meaning: sig.meaning,
		signedAt: new Date(),
		ipAddress: tryClientAddress(event),
		userAgent: event.request.headers.get('user-agent') ?? undefined
	});
}

/**
 * Refuse an operation that would leave the system with zero admins.
 * `wouldRemoveAdminFrom` is the user whose admin access is being removed/disabled.
 * Enforced in BOTH phases — anti-lockout is never optional.
 */
export async function guardLastAdmin(wouldRemoveAdminFrom: string): Promise<void> {
	await connectDB();
	const admins = (await User.find(
		{ isActive: true, 'roles.permissions': { $in: ADMIN_PERMISSIONS } },
		{ _id: 1 }
	).lean()) as any[];
	const remaining = admins.filter((a) => a._id !== wouldRemoveAdminFrom);
	if (remaining.length === 0) {
		throw error(
			409,
			'Refused: this would remove the last administrator. Grant admin to another active user first.'
		);
	}
}

/** Refuse self-targeted destructive actions (self-deactivate / self-demote). */
export function guardNotSelf(event: RequestEvent, targetUserId: string, what: string): void {
	if (event.locals.user?._id === targetUserId) {
		throw error(409, `Refused: you cannot ${what} your own account.`);
	}
}

function tryClientAddress(event: RequestEvent): string | undefined {
	try {
		return event.getClientAddress();
	} catch {
		return event.request.headers.get('x-forwarded-for') ?? undefined;
	}
}
