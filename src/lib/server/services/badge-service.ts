/**
 * badge-service.ts — issue, revoke, print-count and resolve operator badges
 * (BADGE-SYSTEM_PLAN.md §16.1), plus the admin-only enforcement switch (§17.5).
 *
 * A badge is attribution, never authorisation: resolveBadge() tells you WHO
 * scanned; the caller still runs requirePermission() on the web session and
 * badgeHolderCan() on the holder before doing anything with it.
 */
import { customAlphabet } from 'nanoid';
import { connectDB } from '$lib/server/db/connection';
import { OperatorBadge, User, ManufacturingSettings, AuditLog } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { hasPermission } from '$lib/server/permissions';

export type Operator = { _id: string; username: string };
export type BadgeMode = 'off' | 'required';

export class BadgeError extends Error {
	status: number;
	code?: string;
	constructor(message: string, status = 400, code?: string) {
		super(message);
		this.name = 'BadgeError';
		this.status = status;
		this.code = code;
	}
}

export interface BadgeHolder {
	badgeId: string;
	code: string;
	displayName: string;
	user: Operator;
	roles: { roleId: string; roleName: string; permissions: string[] }[];
}

export interface BadgeRow {
	badgeId: string;
	code: string;
	userId: string;
	username: string | null;
	displayName: string;
	status: 'active' | 'revoked';
	issuedAt: string | null;
	issuedBy: string | null;
	revokedAt: string | null;
	revokedBy: string | null;
	revokeReason: string | null;
	lastUsedAt: string | null;
	printCount: number;
	/** Admin-only image URL (GET /admin/badges/[id]/photo?v=…), null when the badge has no photo (§17.6). */
	photoUrl: string | null;
}

// ── code format ───────────────────────────────────────────────────────────

export const BADGE_PREFIX = 'BDG';
// No 0/O/1/I: the code is read by keyboard-wedge guns and, sometimes, by people.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codeBody = customAlphabet(CODE_ALPHABET, 10);
const BADGE_RX = /^BDG-[A-Z0-9]{10}$/i;

export function isBadgeCode(code: string | null | undefined): boolean {
	return BADGE_RX.test((code ?? '').trim());
}

export function newBadgeCode(): string {
	return `${BADGE_PREFIX}-${codeBody()}`;
}

function normalize(code: string | null | undefined): string {
	return (code ?? '').trim().toUpperCase();
}

// ── enforcement switch (§17.5) ────────────────────────────────────────────

export interface BadgeSettings {
	mode: BadgeMode;
	changedAt: string | null;
	changedBy: string | null;
}

/** Read per request, no cache — a flip in the portal takes effect on the next scan. */
export async function badgeMode(): Promise<BadgeMode> {
	await connectDB();
	const s = await ManufacturingSettings.findById('default').select('badge').lean() as any;
	return s?.badge?.mode === 'off' ? 'off' : 'required';
}

export async function badgeSettings(): Promise<BadgeSettings> {
	await connectDB();
	const s = await ManufacturingSettings.findById('default').select('badge').lean() as any;
	return {
		mode: s?.badge?.mode === 'off' ? 'off' : 'required',
		changedAt: s?.badge?.changedAt ? new Date(s.badge.changedAt).toISOString() : null,
		changedBy: s?.badge?.changedBy?.username ?? null
	};
}

/**
 * Admin only — the caller has already checked isAdmin(); this just writes.
 * Turning enforcement OFF is the flip that matters for traceability, so both
 * directions land in the audit log with the old and new value.
 */
export async function setBadgeMode(input: { mode: BadgeMode; reason?: string; user: Operator }): Promise<BadgeSettings> {
	await connectDB();
	if (input.mode !== 'off' && input.mode !== 'required') throw new BadgeError('Badge mode must be off or required.');
	const before = await badgeMode();
	const now = new Date();
	await ManufacturingSettings.updateOne(
		{ _id: 'default' },
		{ $set: { 'badge.mode': input.mode, 'badge.changedAt': now, 'badge.changedBy': { _id: input.user._id, username: input.user.username }, updatedAt: now } },
		{ upsert: true }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'manufacturing_settings',
		recordId: 'default',
		action: 'BADGE_MODE',
		oldData: { mode: before },
		newData: { mode: input.mode },
		changedFields: ['badge.mode'],
		changedBy: input.user.username,
		changedAt: now,
		reason: (input.reason ?? '').trim() || undefined
	});
	return badgeSettings();
}

// ── resolve ───────────────────────────────────────────────────────────────

/**
 * Scanned code → who holds it. Throws BadgeError for anything that must not
 * be attributed: unknown code, revoked badge, deactivated user.
 */
export async function resolveBadge(code: string): Promise<BadgeHolder> {
	await connectDB();
	const c = normalize(code);
	if (!c) throw new BadgeError('Scan your badge.', 400, 'BADGE_REQUIRED');
	if (!isBadgeCode(c)) throw new BadgeError(`${c} is not a badge.`, 400, 'BADGE_INVALID');

	const badge = await OperatorBadge.findOne({ code: c })
		.select('_id code userId displayName status').lean() as any;
	if (!badge) throw new BadgeError('Unknown badge — it may never have been issued, or was reissued.', 404, 'BADGE_UNKNOWN');
	if (badge.status !== 'active') throw new BadgeError(`${badge.displayName}'s badge was revoked — see an admin for a new one.`, 409, 'BADGE_REVOKED');

	const user = await User.findById(badge.userId).select('_id username isActive roles').lean() as any;
	if (!user || user.isActive === false) throw new BadgeError(`${badge.displayName}'s account is deactivated.`, 403, 'BADGE_INACTIVE');

	// Fire-and-forget: a slow write here must not slow the scan.
	OperatorBadge.updateOne({ _id: badge._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});

	return {
		badgeId: badge._id,
		code: badge.code,
		displayName: badge.displayName,
		user: { _id: user._id, username: user.username },
		roles: user.roles ?? []
	};
}

/** Attribution never substitutes for permission: the holder must be allowed too. */
export function badgeHolderCan(holder: BadgeHolder, permission: string): boolean {
	return hasPermission({ roles: holder.roles }, permission);
}

// ── issue / revoke / reissue ──────────────────────────────────────────────

function toRow(b: any): BadgeRow {
	const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
	return {
		badgeId: b._id,
		code: b.code,
		userId: b.userId,
		username: b.username ?? null,
		displayName: b.displayName,
		status: b.status,
		issuedAt: iso(b.issuedAt),
		issuedBy: b.issuedBy?.username ?? null,
		revokedAt: iso(b.revokedAt),
		revokedBy: b.revokedBy?.username ?? null,
		revokeReason: b.revokeReason ?? null,
		lastUsedAt: iso(b.lastUsedAt),
		printCount: b.printCount ?? 0,
		// `v` is the upload time, so a replaced photo gets a new URL and the old one can be cached forever.
		photoUrl: b.photo?.updatedAt ? `/admin/badges/${b._id}/photo?v=${new Date(b.photo.updatedAt).getTime()}` : null
	};
}

async function badgeAudit(action: string, badgeId: string, by: Operator, newData?: unknown, oldData?: unknown, reason?: string): Promise<void> {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'operator_badges',
		recordId: badgeId,
		action,
		newData,
		oldData,
		changedBy: by.username,
		changedAt: new Date(),
		reason
	});
}

export async function issueBadge(input: { userId: string; displayName?: string; photo?: Uint8Array; issuedBy: Operator }): Promise<BadgeRow> {
	await connectDB();
	const user = await User.findById(input.userId).select('_id username firstName lastName isActive').lean() as any;
	if (!user) throw new BadgeError('User not found.', 404);
	if (user.isActive === false) throw new BadgeError(`${user.username} is deactivated — reactivate the account before issuing a badge.`, 409);

	const displayName = (input.displayName ?? '').trim()
		|| [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
		|| user.username;

	const existing = await OperatorBadge.findOne({ userId: user._id, status: 'active' }).select('_id code').lean() as any;
	if (existing) throw new BadgeError(`${user.username} already has an active badge (${existing.code}) — revoke or reissue it instead.`, 409, 'BADGE_EXISTS');

	const now = new Date();
	const by = { _id: input.issuedBy._id, username: input.issuedBy.username };
	const photo = input.photo ? validatePhoto(input.photo) : null;
	// A code collision is a 1-in-32^10 event; retry a couple of times rather than fail.
	for (let attempt = 0; attempt < 3; attempt++) {
		const code = newBadgeCode();
		const id = generateId();
		try {
			await OperatorBadge.create({
				_id: id, code, userId: user._id, username: user.username, displayName,
				status: 'active', issuedAt: now, issuedBy: by, printCount: 0,
				...(photo ? { photo: { ...photo, updatedAt: now, updatedBy: by } } : {})
			});
		} catch (e: any) {
			if (e?.code === 11000) {
				// Either the code collided (retry) or the user just got a badge from another admin (stop).
				const race = await OperatorBadge.findOne({ userId: user._id, status: 'active' }).select('code').lean() as any;
				if (race) throw new BadgeError(`${user.username} already has an active badge (${race.code}).`, 409, 'BADGE_EXISTS');
				continue;
			}
			throw e;
		}
		await badgeAudit('ISSUE', id, by, { code, userId: user._id, displayName, photo: !!photo });
		const doc = await OperatorBadge.findById(id).lean();
		return toRow(doc);
	}
	throw new BadgeError('Could not generate a unique badge code — try again.', 500);
}

export async function revokeBadge(input: { badgeId: string; reason: string; by: Operator }): Promise<BadgeRow> {
	await connectDB();
	const reason = (input.reason ?? '').trim();
	if (!reason) throw new BadgeError('Say why the badge is being revoked.');
	const badge = await OperatorBadge.findById(input.badgeId).lean() as any;
	if (!badge) throw new BadgeError('Badge not found.', 404);
	if (badge.status !== 'active') throw new BadgeError(`${badge.code} is already revoked.`, 409);

	const now = new Date();
	const by = { _id: input.by._id, username: input.by.username };
	await OperatorBadge.updateOne(
		{ _id: badge._id, status: 'active' },
		{ $set: { status: 'revoked', revokedAt: now, revokedBy: by, revokeReason: reason } }
	);
	await badgeAudit('REVOKE', badge._id, by, { status: 'revoked' }, { status: 'active' }, reason);
	return toRow(await OperatorBadge.findById(badge._id).lean());
}

/** Lost or damaged card: revoke the old code and print a new one for the same person. */
export async function reissueBadge(input: { badgeId: string; by: Operator }): Promise<{ revoked: BadgeRow; issued: BadgeRow }> {
	await connectDB();
	// +photo.data: the portrait follows the person onto the new card.
	const old = await OperatorBadge.findById(input.badgeId).select('+photo.data').lean() as any;
	if (!old) throw new BadgeError('Badge not found.', 404);
	if (old.status !== 'active') throw new BadgeError(`${old.code} is already revoked — issue a new badge from the form instead.`, 409);
	const revoked = await revokeBadge({ badgeId: old._id, reason: 'reissued', by: input.by });
	const issued = await issueBadge({
		userId: old.userId, displayName: old.displayName, issuedBy: input.by,
		photo: old.photo?.data ? Buffer.from(old.photo.data, 'base64') : undefined
	});
	await badgeAudit('REISSUE', issued.badgeId, input.by, { code: issued.code }, { badgeId: old._id, code: old.code });
	return { revoked, issued };
}

// ── photo (§17.6) ─────────────────────────────────────────────────────────

/**
 * Decoded bytes. The portal's picker crops to 4:5 and shrinks to 480×600 JPEG
 * in the browser (~50 KB) before upload; this is the ceiling for anything that
 * bypasses it (JS off, a hand-built request).
 */
export const BADGE_PHOTO_MAX_BYTES = 400 * 1024;

export interface BadgePhoto {
	bytes: Buffer;
	contentType: string;
	updatedAt: Date | null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	let out = '';
	for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
	return out;
}

/** Sniff the container from the bytes; the client's declared type is not trusted. */
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'image/png';
	if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
	return null;
}

function validatePhoto(bytes: Uint8Array): { data: string; contentType: string; size: number } {
	if (bytes.length === 0) throw new BadgeError('The photo is empty.');
	if (bytes.length > BADGE_PHOTO_MAX_BYTES) {
		throw new BadgeError(`Photo is ${Math.round(bytes.length / 1024)} KB — the limit is ${BADGE_PHOTO_MAX_BYTES / 1024} KB. Pick it in the Badge Portal, which shrinks it automatically.`, 413, 'PHOTO_TOO_LARGE');
	}
	const contentType = sniffImageType(bytes);
	if (!contentType) throw new BadgeError('Photo must be a JPEG, PNG or WebP image.', 415, 'PHOTO_TYPE');
	return { data: Buffer.from(bytes).toString('base64'), contentType, size: bytes.length };
}

/** Add or replace the portrait on an active badge. The bytes never reach the audit log — only type and size. */
export async function setBadgePhoto(input: { badgeId: string; bytes: Uint8Array; by: Operator }): Promise<BadgeRow> {
	await connectDB();
	const badge = await OperatorBadge.findById(input.badgeId).select('_id status photo.contentType photo.size').lean() as any;
	if (!badge) throw new BadgeError('Badge not found.', 404);
	if (badge.status !== 'active') throw new BadgeError('This badge is revoked — issue a new one and add the photo there.', 409);
	const photo = validatePhoto(input.bytes);
	const now = new Date();
	const by = { _id: input.by._id, username: input.by.username };
	await OperatorBadge.updateOne({ _id: badge._id }, { $set: { photo: { ...photo, updatedAt: now, updatedBy: by } } });
	await badgeAudit(
		'PHOTO_SET', badge._id, by,
		{ contentType: photo.contentType, size: photo.size },
		badge.photo?.size ? { contentType: badge.photo.contentType, size: badge.photo.size } : undefined
	);
	return toRow(await OperatorBadge.findById(badge._id).lean());
}

/** Remove the portrait. Allowed on revoked badges too — the card is history, the face need not be. */
export async function clearBadgePhoto(input: { badgeId: string; by: Operator }): Promise<BadgeRow> {
	await connectDB();
	const badge = await OperatorBadge.findById(input.badgeId).select('_id photo.contentType photo.size').lean() as any;
	if (!badge) throw new BadgeError('Badge not found.', 404);
	if (!badge.photo?.size) throw new BadgeError('This badge has no photo.', 409);
	const by = { _id: input.by._id, username: input.by.username };
	await OperatorBadge.updateOne({ _id: badge._id }, { $unset: { photo: 1 } });
	await badgeAudit('PHOTO_CLEAR', badge._id, by, undefined, { contentType: badge.photo.contentType, size: badge.photo.size });
	return toRow(await OperatorBadge.findById(badge._id).lean());
}

/** The stored bytes for GET /admin/badges/[id]/photo. The only reader of `photo.data`. */
export async function getBadgePhoto(badgeId: string): Promise<BadgePhoto | null> {
	await connectDB();
	const badge = await OperatorBadge.findById(badgeId).select('+photo.data').lean() as any;
	if (!badge?.photo?.data) return null;
	return {
		bytes: Buffer.from(badge.photo.data, 'base64'),
		contentType: badge.photo.contentType || 'image/jpeg',
		updatedAt: badge.photo.updatedAt ? new Date(badge.photo.updatedAt) : null
	};
}

export async function listBadges(): Promise<BadgeRow[]> {
	await connectDB();
	const docs = await OperatorBadge.find({}).sort({ status: 1, issuedAt: -1 }).lean() as any[];
	return docs.map(toRow);
}

export async function getBadge(badgeId: string): Promise<BadgeRow | null> {
	await connectDB();
	const doc = await OperatorBadge.findById(badgeId).lean();
	return doc ? toRow(doc) : null;
}

/** Batch print: the selected badges in the order they were selected; unknown ids are dropped. */
export async function getBadges(badgeIds: string[]): Promise<BadgeRow[]> {
	await connectDB();
	if (badgeIds.length === 0) return [];
	const docs = await OperatorBadge.find({ _id: { $in: badgeIds } }).lean() as any[];
	const byId = new Map(docs.map(d => [d._id, toRow(d)]));
	return badgeIds.map(id => byId.get(id)).filter((b): b is BadgeRow => !!b);
}

export async function bumpPrintCount(badgeId: string | string[]): Promise<void> {
	const ids = Array.isArray(badgeId) ? badgeId : [badgeId];
	if (ids.length === 0) return;
	await connectDB();
	await OperatorBadge.updateMany({ _id: { $in: ids } }, { $inc: { printCount: 1 } });
}
