/**
 * Recursive composition resolver for CvProject.
 *
 * - members[] is the direct training set.
 * - composedOf[] is a list of child project IDs.
 * - isLiveComposition === true flattens composedOf at read time (children's
 *   members are unioned in). When false, composedOf is informational only —
 *   members[] is the frozen training set.
 *
 * Guardrails:
 *   - Recursion depth limited to MAX_DEPTH (5).
 *   - Cycle detection via a visited set; cycles are silently broken (the
 *     repeating project is skipped, not thrown).
 */
import { CvProject } from '$lib/server/db/models/cv-project.js';

const MAX_DEPTH = 5;

export interface ResolvedMembers {
	direct: string[];           // member ids on the project itself
	composed: string[];         // member ids added through live composition (deduped vs direct)
	all: string[];              // direct ∪ composed
	cycleSkipped: string[];     // project ids that were skipped to avoid cycles
}

export async function resolveProjectMembers(projectId: string): Promise<ResolvedMembers> {
	const visited = new Set<string>();
	const direct: string[] = [];
	const composedSet = new Set<string>();
	const cycleSkipped: string[] = [];

	async function walk(id: string, depth: number, isRoot: boolean) {
		if (depth > MAX_DEPTH) return;
		if (visited.has(id)) {
			if (!isRoot) cycleSkipped.push(id);
			return;
		}
		visited.add(id);

		const project = await CvProject.findById(id).select('members composedOf isLiveComposition').lean() as any;
		if (!project) return;

		const members: string[] = project.members ?? [];

		if (isRoot) {
			for (const m of members) direct.push(m);
		} else {
			for (const m of members) {
				if (!direct.includes(m)) composedSet.add(m);
			}
		}

		// Only recurse if live composition is on.
		if (project.isLiveComposition && Array.isArray(project.composedOf)) {
			for (const childId of project.composedOf) {
				await walk(childId, depth + 1, false);
			}
		}
	}

	await walk(projectId, 0, true);

	const composed = [...composedSet];
	const all = [...direct, ...composed];
	return { direct, composed, all, cycleSkipped };
}
