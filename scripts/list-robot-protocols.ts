/**
 * Inventory every protocol currently stored on each OT-2.
 *
 * Each robot keeps its own `/data/protocols/` folder — uploads accumulate
 * until someone deletes them. This script lists all three robots with:
 *   - protocol id
 *   - filename
 *   - upload date
 *   - protocol name (from metadata)
 *
 * Sorted oldest-first within each robot so you can spot the cruft quickly.
 *
 * Run:
 *   npx tsx scripts/list-robot-protocols.ts
 *
 * Pruning hint printed at the end — copy the UUIDs you want gone and
 * delete them via the clone's protocols page (each delete has a confirm
 * dialog), or uncomment the `RALPH_PRUNE` block at the bottom of this
 * script to hard-delete ids listed in `toDelete` below.
 */

const ROBOTS = [
	{ name: 'Robot 1 (muddy-water / B14)', host: 'muddy-water.local' },
	{ name: 'Robot 2 (R04)', host: 'OT2CEP20210817R04.local' },
	{ name: 'Robot 3 (hidden-leaf / B07)', host: 'hidden-leaf.local' }
];

async function listProtocols(host: string): Promise<any[]> {
	const res = await fetch(`http://${host}:31950/protocols`, {
		headers: { 'opentrons-version': '*' },
		signal: AbortSignal.timeout(10_000)
	});
	if (!res.ok) throw new Error(`${host} → HTTP ${res.status}`);
	const body = (await res.json()) as { data?: any[] };
	return body.data ?? [];
}

function fmt(iso: string): string {
	try {
		return new Date(iso).toLocaleString('en-US', {
			year: 'numeric',
			month: 'short',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
	} catch {
		return iso;
	}
}

async function main() {
	console.log('\n=== Protocol inventory across all 3 robots ===\n');
	for (const { name, host } of ROBOTS) {
		console.log(`\n${name}  (${host})`);
		console.log('─'.repeat(80));
		let protocols: any[] = [];
		try {
			protocols = await listProtocols(host);
		} catch (e) {
			console.log(`  unreachable: ${(e as Error).message}`);
			continue;
		}
		if (protocols.length === 0) {
			console.log('  (empty)');
			continue;
		}
		protocols.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
		console.log(`  ${protocols.length} protocol(s) — oldest first:\n`);
		for (const p of protocols) {
			const mainFile = p.files?.find((f: any) => f.role === 'main' || !f.role)?.name ?? p.files?.[0]?.name ?? '—';
			const protoName = p.metadata?.protocolName ?? p.metadata?.name ?? '—';
			console.log(`    ${fmt(p.createdAt)}   ${p.id}`);
			console.log(`        ${mainFile}${protoName !== '—' && protoName !== mainFile ? `   [${protoName}]` : ''}`);
		}
	}
	console.log('\n');
	console.log('To delete a protocol from a robot:');
	console.log('  curl -X DELETE -H "opentrons-version: *" http://<host>:31950/protocols/<id>');
	console.log('or use the clone\'s delete button on the protocols page (has confirm).\n');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
