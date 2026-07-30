import { connectDB, KanbanPolicy } from '$lib/server/db';
import type { KanbanBoard } from '$lib/shared/kanban-status';

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

export function boardPolicyOf(policy: any, board: KanbanBoard): { readyCap: number; minOrderPoint: number } {
	return {
		readyCap: policy?.boards?.[board]?.readyCap ?? 8,
		minOrderPoint: policy?.boards?.[board]?.minOrderPoint ?? 3
	};
}
