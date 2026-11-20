/**
 * Keep an OT-2's run and protocol store small (2026-11-20).
 *
 * The robot keeps at most 20 runs and drops the oldest when a new run is
 * created, so B07 sat at 20 and every loop start's POST /runs also deleted an
 * old run on the robot. Pruning after a loop ends moves that off the next
 * start. Never touched: the current run, the newest KEEP_RUNS runs, a run not
 * yet ended, and any protocol BIMS's robot record lists or a kept run uses.
 * Best effort and bounded; never throws.
 */
import { connectDB } from '$lib/server/db/connection';
import { OpentronsRobot } from '$lib/server/db/models';
import { robotDelete, robotGet } from './proxy';

export const KEEP_RUNS = 5;
const TERMINAL = new Set(['succeeded', 'failed', 'stopped']);

interface RunRow {
	id: string;
	status?: string;
	createdAt?: string;
	protocolId?: string;
}
interface ProtocolRow {
	id: string;
	createdAt?: string;
}

export interface PrunePlan {
	runs: string[];
	protocols: string[];
}

/** What may go: pure, so the rules are tested apart from the robot. */
export function prunePlan(runs: RunRow[], protocols: ProtocolRow[], currentRunId: string | null, registered: Set<string>, keepRuns = KEEP_RUNS): PrunePlan {
	const newestFirst = [...runs].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
	const kept = new Set(newestFirst.slice(0, keepRuns).map((r) => r.id));
	if (currentRunId) kept.add(currentRunId);
	const goRuns = newestFirst.filter((r) => !kept.has(r.id) && TERMINAL.has(String(r.status ?? ''))).map((r) => r.id);
	const gone = new Set(goRuns);
	const inUse = new Set(runs.filter((r) => !gone.has(r.id) && r.protocolId).map((r) => String(r.protocolId)));
	const goProtocols = protocols.filter((p) => !registered.has(p.id) && !inUse.has(p.id)).map((p) => p.id);
	return { runs: goRuns, protocols: goProtocols };
}

async function readData(robot: any, path: string): Promise<{ data: any[]; links: any } | null> {
	try {
		const r = await robotGet(robot, path);
		if (!r.ok) return null;
		const body: any = await r.json().catch(() => null);
		return { data: Array.isArray(body?.data) ? body.data : [], links: body?.links ?? null };
	} catch {
		return null;
	}
}

export interface PruneResult {
	runsDeleted: string[];
	protocolsDeleted: string[];
	errors: string[];
	skipped: string | null;
}

export async function pruneRobotStore(robot: any, opts: { budgetMs?: number } = {}): Promise<PruneResult> {
	const out: PruneResult = { runsDeleted: [], protocolsDeleted: [], errors: [], skipped: null };
	if (!robot || process.env.VITEST) return { ...out, skipped: 'no robot' };
	const deadline = Date.now() + (opts.budgetMs ?? 60_000);
	try {
		await connectDB();
		const [runs, protocols, rec] = await Promise.all([
			readData(robot, '/runs'),
			readData(robot, '/protocols'),
			OpentronsRobot.findById(String(robot._id)).select('protocols.opentronsProtocolId').lean() as Promise<any>
		]);
		if (!runs || !protocols) return { ...out, skipped: 'the robot did not list its runs and protocols' };
		const href = String(runs.links?.current?.href ?? '');
		const currentRunId = href ? (href.split('/').pop() ?? null) : null;
		// A run still going: nothing is pruned beside it.
		if (runs.data.some((r: RunRow) => !TERMINAL.has(String(r.status ?? '')))) return { ...out, skipped: 'a run is not over' };
		const registered = new Set<string>(((rec?.protocols ?? []) as any[]).map((p) => String(p?.opentronsProtocolId ?? '')).filter(Boolean));
		const plan = prunePlan(runs.data, protocols.data, currentRunId, registered);
		for (const id of plan.runs) {
			if (Date.now() > deadline) break;
			const r = await robotDelete(robot, `/runs/${id}`).catch((e) => e as Error);
			if (r instanceof Error) out.errors.push(`run ${id.slice(0, 8)}: ${r.message}`.slice(0, 200));
			else if (r.ok) out.runsDeleted.push(id);
			else out.errors.push(`run ${id.slice(0, 8)}: HTTP ${r.status}`);
		}
		for (const id of plan.protocols) {
			if (Date.now() > deadline) break;
			const r = await robotDelete(robot, `/protocols/${id}`).catch((e) => e as Error);
			if (r instanceof Error) out.errors.push(`protocol ${id.slice(0, 8)}: ${r.message}`.slice(0, 200));
			else if (r.ok) out.protocolsDeleted.push(id);
			else out.errors.push(`protocol ${id.slice(0, 8)}: HTTP ${r.status}`);
		}
	} catch (e) {
		out.errors.push(e instanceof Error ? e.message : String(e));
	}
	return out;
}
