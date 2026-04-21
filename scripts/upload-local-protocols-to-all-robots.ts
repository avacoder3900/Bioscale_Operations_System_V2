/**
 * Upload every .py in the local Opentrons App protocol library to every OT-2.
 *
 * Local library: ~/Library/Application Support/Opentrons/protocols/<uuid>/src/*.py
 * Each file is uploaded once to each robot via POST /protocols (multipart).
 * Each upload creates a fresh UUID on the robot — duplicates are possible
 * (see scripts/prune-robot-protocols.ts for cleanup).
 *
 * Run:
 *   npx tsx scripts/upload-local-protocols-to-all-robots.ts          # dry run
 *   UPLOAD_APPLY=1 npx tsx scripts/upload-local-protocols-to-all-robots.ts  # do it
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOCAL_ROOT = join(homedir(), 'Library', 'Application Support', 'Opentrons', 'protocols');

const ROBOTS = [
	{ name: 'Robot 1 (muddy-water / B14)', host: 'muddy-water.local' },
	{ name: 'Robot 2 (R04)', host: 'OT2CEP20210817R04.local' },
	{ name: 'Robot 3 (hidden-leaf / B07)', host: 'hidden-leaf.local' }
];

const APPLY = process.env.UPLOAD_APPLY === '1';

interface LocalProtocol {
	uuid: string;
	fullPath: string;
	filename: string;
	bytes: number;
}

async function findLocalProtocols(): Promise<LocalProtocol[]> {
	const folders = await readdir(LOCAL_ROOT, { withFileTypes: true });
	const results: LocalProtocol[] = [];
	for (const f of folders) {
		if (!f.isDirectory()) continue;
		const srcDir = join(LOCAL_ROOT, f.name, 'src');
		let entries;
		try {
			entries = await readdir(srcDir);
		} catch {
			continue;
		}
		const pyFiles = entries.filter((e) => e.endsWith('.py'));
		if (pyFiles.length === 0) continue;
		for (const py of pyFiles) {
			const full = join(srcDir, py);
			const s = await stat(full);
			results.push({ uuid: f.name, fullPath: full, filename: py, bytes: s.size });
		}
	}
	return results;
}

async function uploadOne(
	host: string,
	p: LocalProtocol
): Promise<{ ok: boolean; status: number; protocolId?: string; error?: string }> {
	const buf = await readFile(p.fullPath);
	const form = new FormData();
	form.append('files', new Blob([buf], { type: 'text/x-python' }), p.filename);
	try {
		const res = await fetch(`http://${host}:31950/protocols`, {
			method: 'POST',
			headers: { 'opentrons-version': '*' },
			body: form,
			signal: AbortSignal.timeout(60_000)
		});
		const body = await res.json().catch(() => null as any);
		if (!res.ok) return { ok: false, status: res.status, error: JSON.stringify(body).slice(0, 200) };
		return { ok: true, status: res.status, protocolId: body?.data?.id };
	} catch (e) {
		return { ok: false, status: 0, error: (e as Error).message };
	}
}

async function main() {
	console.log(`\n=== Local → all robots  (mode: ${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

	const locals = await findLocalProtocols();
	console.log(`Local library: ${locals.length} .py file(s) across ${new Set(locals.map((l) => l.uuid)).size} folder(s)\n`);
	for (const l of locals) {
		console.log(`  ${l.filename}  (${(l.bytes / 1024).toFixed(1)} KB, folder ${l.uuid.slice(0, 8)})`);
	}

	console.log(`\nTargets: ${ROBOTS.length} robots.`);
	const totalOps = locals.length * ROBOTS.length;
	console.log(`Planned operations: ${totalOps} uploads (${locals.length} × ${ROBOTS.length}).\n`);

	if (!APPLY) {
		console.log('Dry run only. Re-run with  UPLOAD_APPLY=1  to actually upload.\n');
		return;
	}

	let ok = 0;
	let failed = 0;
	for (const robot of ROBOTS) {
		console.log(`\n→ ${robot.name}  (${robot.host})`);
		console.log('─'.repeat(80));
		for (const p of locals) {
			process.stdout.write(`  ${p.filename.padEnd(65)} `);
			const r = await uploadOne(robot.host, p);
			if (r.ok) {
				ok++;
				console.log(`OK  ${r.protocolId?.slice(0, 8)}…`);
			} else {
				failed++;
				console.log(`FAIL (${r.status}) ${r.error ?? ''}`);
			}
		}
	}

	console.log('\n' + '='.repeat(80));
	console.log(`Uploaded: ${ok} / ${totalOps}   Failed: ${failed}`);
	if (failed === 0) {
		console.log('\nAll protocols are now on every robot.');
		console.log('Hint: scripts/prune-robot-protocols.ts will collapse duplicates if you need to trim.\n');
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
