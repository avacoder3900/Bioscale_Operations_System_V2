import type { RequestEvent } from '@sveltejs/kit';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase64url, encodeHexLowerCase } from '@oslojs/encoding';
import { connectDB, Session, User } from '$lib/server/db';

const DAY_IN_MS = 1000 * 60 * 60 * 24;

export const sessionCookieName = 'auth-session';

export function generateSessionToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	return encodeBase64url(bytes);
}

export async function createSession(token: string, userId: string) {
	await connectDB();
	const sessionId = encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
	const session = await Session.create({
		_id: sessionId,
		userId,
		expiresAt: new Date(Date.now() + DAY_IN_MS * 30)
	});
	return session;
}

export async function validateSessionToken(token: string) {
	await connectDB();
	const sessionId = encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
	const session = await Session.findById(sessionId).lean();

	if (!session) {
		return { session: null, user: null };
	}

	const sessionExpired = Date.now() >= new Date(session.expiresAt).getTime();
	if (sessionExpired) {
		await Session.deleteOne({ _id: session._id });
		return { session: null, user: null };
	}

	// Renew if within 15 days of expiry
	const renewSession = Date.now() >= new Date(session.expiresAt).getTime() - DAY_IN_MS * 15;
	if (renewSession) {
		const newExpiry = new Date(Date.now() + DAY_IN_MS * 30);
		await Session.updateOne({ _id: session._id }, { $set: { expiresAt: newExpiry } });
		session.expiresAt = newExpiry;
	}

	const user = await User.findById(session.userId).select('-passwordHash').lean();
	if (!user || !(user as any).isActive) {
		await Session.deleteOne({ _id: session._id });
		return { session: null, user: null };
	}

	return { session, user };
}

export type SessionValidationResult = Awaited<ReturnType<typeof validateSessionToken>>;

export async function invalidateSession(sessionId: string) {
	await connectDB();
	await Session.deleteOne({ _id: sessionId });
}

export function setSessionTokenCookie(event: RequestEvent, token: string, expiresAt: Date) {
	event.cookies.set(sessionCookieName, token, {
		httpOnly: true,
		secure: !import.meta.env.DEV,
		sameSite: 'lax',
		expires: expiresAt,
		path: '/'
	});
}

export function deleteSessionTokenCookie(event: RequestEvent) {
	event.cookies.delete(sessionCookieName, {
		httpOnly: true,
		secure: !import.meta.env.DEV,
		sameSite: 'lax',
		path: '/'
	});
}
