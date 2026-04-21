/**
 * Prune duplicate protocol uploads from each OT-2.
 *
 * Strategy: group a robot's protocols by main-file filename; within each
 * group, keep the newest and mark every older upload for deletion.
 *
 * Default is DRY RUN — lists what would be deleted, deletes nothing.
 * Pass PRUNE_APPLY=1 to actually delete.
 *
 * Run:
 *   npx tsx scripts/prune-robot-protocols.ts                 # dry run
 *   PRUNE_APPLY=1 npx tsx scripts/prune-robot-protocols.ts   # do it
 *
 * Scope a single robot:
 *   PRUNE_ROBOT=hidden-leaf.local npx tsx scripts/prune-robot-protocols.ts
 */

const ALL_ROBOTS = [
	{ name: 'Robot 1 (muddy-water / B14)', host: 'muddy-water.local' },
	{ name: 'Robot 2 (R04)', host: 'OT2CEP20210817R04.local' },
	{ name: 'Robot 3 (hidden-leaf / B07)', host: 'hidden-leaf.local' }
];

const APPLY = process.env.PRUNE_APPLY === '1';
const SINGLE = process.env.PRUNE_ROBOT?.trim() || null;
const ROBOTS = SINGLE ? ALL_ROBOTS.filter((r) => r.host === SINGLE) : ALL_ROBOTS;

async function listProtocols(host: string): Promise<any[]> {
	const res = await fetch(`http://${host}:31950/protocols`, {
		headers: { 'opentrons-version': '*' },
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (((await res.json()) as { data?: any[] }).data ?? []);
}

async function deleteProtocol(host: string, id: string): Promise<{ ok: boolean; status: number }> {
	const res = await fetch(`http://${host}:31950/protocols/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: { 'opentrons-version': '*' },
		signal: AbortSignal.timeout(15_000)
	});
	return { ok: res.ok, status: res.status };
}

function mainFile(p: any): string {
	const files = p.files ?? [];
	return files.find((f: any) => f.role === 'main')?.name ?? files[0]?.name ?? '(unknown)';
}

async function prune(name: string, host: string) {
	console.log(`\n${name}  (${host})`);
	console.log('─'.repeat(80));
	let protocols: any[] = [];
	try {
		protocols = await listProtocols(host);
	} catch (e) {
		console.log(`  unreachable: ${(e as Error).message}`);
		return { kept: 0, deleted: 0, failed: 0 };
	}
	if (protocols.length === 0) {
		console.log('  (empty — nothing to prune)');
		return { kept: 0, deleted: 0, failed: 0 };
	}

	// Group by main filename
	const groups = new Map<string, any[]>();
	for (const p of protocols) {
		const key = mainFile(p);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(p);
	}

	let kept = 0;
	let toDeleteIds: string[] = [];

	for (const [filename, group] of groups) {
		group.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		const keep = group[0];
		const drop = group.slice(1);
		kept++;
		console.log(`\n  ${filename}  (${group.length} copies)`);
		console.log(`    KEEP  ${keep.createdAt.slice(0, 16).replace('T', ' ')}  ${keep.id}`);
		for (const d of drop) {
			toDeleteIds.push(d.id);
			console.log(`    drop  ${d.createdAt.slice(0, 16).replace('T', ' ')}  ${d.id}`);
		}
	}

	console.log(`\n  Summary: keep ${kept}, ${APPLY ? 'deleting' : 'would delete'} ${toDeleteIds.length}`);

	if (!APPLY) return { kept, deleted: 0, failed: 0 };

	let deleted = 0;
	let failed = 0;
	for (const id of toDeleteIds) {
		const r = await deleteProtocol(host, id);
		if (r.ok) {
			deleted++;
			process.stdout.write('.');
		} else {
			failed++;
			console.log(`\n    FAIL  ${id}  HTTP ${r.status}`);
		}
	}
	console.log(`\n  Deleted: ${deleted}   Failed: ${failed}`);
	return { kept, deleted, failed };
}

async function main() {
	console.log(`\n=== Prune duplicate protocols  (mode: ${APPLY ? 'APPLY' : 'DRY RUN'}) ===`);
	if (SINGLE) console.log(`Scoped to: ${SINGLE}`);

	let totals = { kept: 0, deleted: 0, failed: 0 };
	for (const { name, host } of ROBOTS) {
		const r = await prune(name, host);
		totals.kept += r.kept;
		totals.deleted += r.deleted;
		totals.failed += r.failed;
	}

	console.log('\n' + '='.repeat(80));
	console.log(
		`Total: keep ${totals.kept} unique protocols, ${APPLY ? 'deleted' : 'would delete'} ${totals.deleted} duplicates` +
			(totals.failed ? `  (${totals.failed} failures)` : '')
	);
	if (!APPLY) console.log('\nDry run only. Re-run with  PRUNE_APPLY=1  to actually delete.\n');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
