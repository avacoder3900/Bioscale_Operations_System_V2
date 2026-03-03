/**
 * Box OAuth 2.0 callback handler.
 * Receives the authorization code after user grants access in the Box consent screen.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB, Integration, AuditLog, generateId } from '$lib/server/db';
import { exchangeCode } from '$lib/server/box';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	const code = url.searchParams.get('code');
	const errorParam = url.searchParams.get('error');

	if (errorParam) {
		throw redirect(303, `/spu/bom/settings?error=${encodeURIComponent(errorParam)}`);
	}

	if (!code) {
		throw redirect(303, '/spu/bom/settings?error=No+authorization+code+received');
	}

	await connectDB();

	const { accessToken, refreshToken, expiresIn } = await exchangeCode(code);

	// Upsert Box integration record
	const existing = await Integration.findOne({ type: 'box' }).lean() as any;
	const expiresAt = new Date(Date.now() + expiresIn * 1000);

	if (existing) {
		await Integration.updateOne(
			{ _id: existing._id },
			{
				$set: {
					accessToken,
					refreshToken,
					expiresAt,
					isActive: true
				}
			}
		);
	} else {
		await Integration.create({
			_id: generateId(),
			type: 'box',
			accessToken,
			refreshToken,
			expiresAt,
			isActive: true
		});
	}

	// Audit log
	if (locals.user) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'integrations',
			recordId: existing?._id ?? 'new',
			action: existing ? 'UPDATE' : 'INSERT',
			newData: { type: 'box', connected: true },
			changedBy: locals.user.username ?? locals.user._id
		});
	}

	throw redirect(303, '/spu/documents/box');
};
