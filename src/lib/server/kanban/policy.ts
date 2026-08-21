import { connectDB, KanbanPolicy } from '$lib/server/db';

/** Load the policy singleton, creating it with seed defaults on first use. */
export async function getKanbanPolicy(): Promise<any> {
	await connectDB();
	let policy: any = await KanbanPolicy.findById('default').lean();
	if (!policy) {
		await KanbanPolicy.create({ _id: 'default' });
		policy = await KanbanPolicy.findById('default').lean();
	}
	return policy;
}

/**
 * KB2-16: one queue, one policy block. Falls back to the pre-migration
 * boards.ops values so the code is safe to deploy before the data migration
 * has run.
 */
export function queuePolicyOf(policy: any): { readyCap: number; minOrderPoint: number } {
	return {
		readyCap: policy?.readyCap ?? policy?.boards?.ops?.readyCap ?? 8,
		minOrderPoint: policy?.minOrderPoint ?? policy?.boards?.ops?.minOrderPoint ?? 3
	};
}
