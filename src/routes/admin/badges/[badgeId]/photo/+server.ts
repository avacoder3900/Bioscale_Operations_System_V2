/**
 * GET /admin/badges/[badgeId]/photo — the portrait on a badge
 * (BADGE-SYSTEM_PLAN.md §17.6). Admin only, like the rest of the portal.
 * `?v=<upload time>` in the URL is the cache key: a replaced photo gets a new
 * URL, so the response can be cached for a year.
 */
import { error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/permissions';
import { getBadgePhoto } from '$lib/server/services/badge-service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	if (!isAdmin(locals.user)) throw error(403, 'Admin access required');
	const photo = await getBadgePhoto(params.badgeId);
	if (!photo) throw error(404, 'This badge has no photo');
	return new Response(new Uint8Array(photo.bytes), {
		status: 200,
		headers: {
			'Content-Type': photo.contentType,
			'Content-Length': String(photo.bytes.byteLength),
			'Cache-Control': 'private, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
