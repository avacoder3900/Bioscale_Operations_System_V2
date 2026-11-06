/**
 * Run the automated robot arm tests (vitest, no arm, no DB) and store the
 * result for Maintenance → Tests (2026-11-06).
 *
 *   npm run test:arm-report             # run + store one robot_arm_unit_runs row
 *   npm run test:arm-report -- --dry    # run + print, store nothing
 *
 * "Arm tests" = every unit test file whose path has robot-arm in it
 * (src/lib/robot-arm, src/lib/server/robot-arm-*, src/routes/api/robot-arm).
 * The row is stored whether the tests pass or fail; the exit code is vitest's.
 */
import 'dotenv/config';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import mongoose from 'mongoose';
import { RobotArmUnitRun } from '../src/lib/server/db/models/index.js';

const DRY = process.argv.includes('--dry');

interface VitestJson {
	numTotalTests: number;
	numPassedTests: number;
	numFailedTests: number;
	numPendingTests: number;
	startTime: number;
	testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[];
}

const git = (cmd: string): string | null => {
	try {
		return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim() || null;
	} catch {
		return null;
	}
};

async function main() {
	const dir = mkdtempSync(join(tmpdir(), 'arm-unit-'));
	const out = join(dir, 'result.json');
	const started = Date.now();
	const run = spawnSync(
		'npx',
		['vitest', 'run', '--config', 'tests/vitest.unit.config.ts', 'robot-arm', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`],
		// No DB for the tests: dotenv above loaded MONGODB_URI for the write below, not for them.
		{ stdio: 'inherit', shell: true, env: { ...process.env, MONGODB_URI: '' } }
	);
	let r: VitestJson;
	try {
		r = JSON.parse(readFileSync(out, 'utf8'));
	} catch {
		console.error('vitest wrote no JSON result; nothing stored.');
		process.exit(run.status || 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const files = r.testResults
		.map((f) => ({
			file: relative(process.cwd(), f.name).split(sep).join('/'),
			total: f.assertionResults.length,
			passed: f.assertionResults.filter((a) => a.status === 'passed').length,
			failures: f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName)
		}))
		.sort((a, b) => a.file.localeCompare(b.file));
	const row = {
		at: new Date(r.startTime || started),
		total: r.numTotalTests,
		passed: r.numPassedTests,
		failed: r.numFailedTests,
		skipped: r.numPendingTests,
		durationMs: Date.now() - started,
		files,
		branch: git('branch --show-current'),
		commit: git('rev-parse --short HEAD'),
		ranBy: git('config user.name')
	};
	console.log(`\nArm unit tests: ${row.passed}/${row.total} passed in ${files.length} files (${row.branch} @ ${row.commit})`);

	if (DRY) {
		console.log('--dry: not stored.');
	} else {
		const uri = process.env.MONGODB_URI;
		if (!uri) throw new Error('MONGODB_URI is not set');
		await mongoose.connect(uri);
		const doc = await RobotArmUnitRun.create(row);
		console.log(`Stored ${doc._id} in robot_arm_unit_runs.`);
		await mongoose.disconnect();
	}
	process.exit(run.status ?? 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
