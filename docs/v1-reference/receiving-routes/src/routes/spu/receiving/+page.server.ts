import { db } from '$lib/server/db';
import { receivingLot, partDefinition } from '$lib/server/db/schema';
import { requirePermission } from '$lib/server/auth/permissions';
import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	await requirePermission(locals.user, 'part:read');

	const lots = await db
		.select({
			lotId: receivingLot.lotId,
			partId: receivingLot.partId,
			quantity: receivingLot.quantity,
			createdAt: receivingLot.createdAt,
			inspectionPathway: receivingLot.inspectionPathway,
			status: receivingLot.status,
			partNumber: partDefinition.partNumber,
			partName: partDefinition.name
		})
		.from(receivingLot)
		.leftJoin(partDefinition, eq(receivingLot.partId, partDefinition.id))
		.orderBy(desc(receivingLot.createdAt));

	return { lots };
};
