import { error } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, ReceivingLot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

function requireAccessionPermission(user: any): void {
	if (!hasPermission(user, 'inventory:write') && !hasPermission(user, 'inventory:read') && !hasPermission(user, 'admin:full')) {
		throw error(403, 'Permission denied: requires inventory:read, inventory:write, or admin:full');
	}
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireAccessionPermission(locals.user);
	await connectDB();

	const lot = await ReceivingLot.findById(params.lotId).lean() as any;
	if (!lot) throw error(404, 'Lot not found');

	return {
		lot: JSON.parse(JSON.stringify(lot))
	};
};
