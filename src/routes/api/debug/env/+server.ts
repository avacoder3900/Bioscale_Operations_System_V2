import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

/**
 * Diagnostic endpoint — reports whether key env vars are detected
 * without exposing their values. Admin-only.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	// Allow any logged-in user for now; tighten if needed

	const detected = (name: string) => {
		const val = (env as any)[name];
		if (!val) return { present: false, length: 0 };
		return { present: true, length: String(val).length };
	};

	return json({
		user: locals.user.username,
		env: {
			RESEND_API_KEY: detected('RESEND_API_KEY'),
			RESEND_FROM_ADDRESS: { present: !!env.RESEND_FROM_ADDRESS, value: env.RESEND_FROM_ADDRESS ?? null },
			ANTHROPIC_API_KEY: detected('ANTHROPIC_API_KEY'),
			GEMINI_API_KEY: detected('GEMINI_API_KEY'),
			AGENT_API_KEY: detected('AGENT_API_KEY'),
			CRON_SECRET: detected('CRON_SECRET'),
			MOCREO_EMAIL: { present: !!env.MOCREO_EMAIL },
			MOCREO_PASSWORD: detected('MOCREO_PASSWORD'),
			BIMS_BASE_URL: { present: !!env.BIMS_BASE_URL, value: env.BIMS_BASE_URL ?? null },
			MONGODB_URI: detected('MONGODB_URI')
		}
	});
};
