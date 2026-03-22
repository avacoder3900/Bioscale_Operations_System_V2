import { fail, redirect } from '@sveltejs/kit';
import { connectDB, User } from '$lib/server/db';
import bcrypt from 'bcryptjs';
import { generateSessionToken, createSession, setSessionTokenCookie } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		redirect(302, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const username = formData.get('username')?.toString().trim();
		const password = formData.get('password')?.toString();

		if (!username || !password) {
			return fail(400, { error: 'Username and password are required' });
		}

		try {
			await connectDB();
			const userRecord = await User.findOne({ username }).lean();

			if (!userRecord) {
				return fail(400, { error: 'Invalid username or password' });
			}

			const validPassword = await bcrypt.compare(password, userRecord.passwordHash);

			if (!validPassword) {
				return fail(400, { error: 'Invalid username or password' });
			}

			if (!userRecord.isActive) {
				return fail(403, { error: 'Account is deactivated. Contact an administrator.' });
			}

			const token = generateSessionToken();
			const session = await createSession(token, userRecord._id);
			setSessionTokenCookie(event, token, session.expiresAt);

			// Update last login timestamp (non-blocking)
			User.updateOne({ _id: userRecord._id }, { $set: { lastLoginAt: new Date() } }).catch(
				(err: Error) => console.error('Failed to update lastLoginAt:', err)
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Login error:', message, err);
			return fail(500, { error: `Server error: ${message}` });
		}

		redirect(302, '/');
	}
};

export const config = { maxDuration: 60 };
