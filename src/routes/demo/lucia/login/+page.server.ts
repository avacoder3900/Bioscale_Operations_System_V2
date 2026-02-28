import { fail, redirect } from '@sveltejs/kit';
import { connectDB, User, generateId } from '$lib/server/db';
import bcrypt from 'bcryptjs';
import { generateSessionToken, createSession, setSessionTokenCookie } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(302, '/demo/lucia');
	return {};
};

export const actions: Actions = {
	login: async (event) => {
		const form = await event.request.formData();
		const username = form.get('username')?.toString().trim();
		const password = form.get('password')?.toString();
		if (!username || !password) return fail(400, { error: 'Username and password are required' });

		await connectDB();
		const user = await User.findOne({ username }).lean();
		if (!user) return fail(400, { error: 'Invalid credentials' });

		const valid = await bcrypt.compare(password, user.passwordHash);
		if (!valid) return fail(400, { error: 'Invalid credentials' });

		const token = generateSessionToken();
		const session = await createSession(token, user._id);
		setSessionTokenCookie(event, token, session.expiresAt);
		redirect(302, '/demo/lucia');
	},

	register: async (event) => {
		const form = await event.request.formData();
		const username = form.get('username')?.toString().trim();
		const password = form.get('password')?.toString();
		if (!username || !password) return fail(400, { error: 'Username and password are required' });

		await connectDB();
		const existing = await User.findOne({ username });
		if (existing) return fail(400, { error: 'Username already exists' });

		const passwordHash = await bcrypt.hash(password, 10);
		const userId = generateId();
		await User.create({ _id: userId, username, passwordHash });

		const token = generateSessionToken();
		const session = await createSession(token, userId);
		setSessionTokenCookie(event, token, session.expiresAt);
		redirect(302, '/demo/lucia');
	}
};
