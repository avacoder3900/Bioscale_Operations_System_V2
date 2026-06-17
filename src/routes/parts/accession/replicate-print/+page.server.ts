import { error } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, PartDefinition } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export type ReplicatePart = {
	id: string;
	partNumber: string;
	name: string;
	barcode: string;
	category: string | null;
	bomType: string | null;
};

function requireAccessionPermission(user: any): void {
	if (!hasPermission(user, 'inventory:write') && !hasPermission(user, 'inventory:read') && !hasPermission(user, 'admin:full')) {
		throw error(403, 'Permission denied: requires inventory:read, inventory:write, or admin:full');
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAccessionPermission(locals.user);
	await connectDB();

	const parts = await PartDefinition.find({
		isActive: true,
		barcode: { $exists: true, $nin: [null, ''] }
	})
		.select('partNumber name barcode category bomType')
		.sort({ partNumber: 1 })
		.lean() as any[];

	const registered: ReplicatePart[] = parts.map((p: any) => ({
		id: p._id,
		partNumber: p.partNumber ?? '',
		name: p.name ?? '',
		barcode: p.barcode,
		category: p.category ?? null,
		bomType: p.bomType ?? null
	}));

	return { registered: JSON.parse(JSON.stringify(registered)) as ReplicatePart[] };
};
