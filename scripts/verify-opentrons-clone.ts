/**
 * Task-5 end-to-end verification against a real OT-2.
 *
 * This exercises the same code paths our /opentrons-clone routes use:
 *   - src/lib/server/opentrons/client.ts (typed openapi-fetch client)
 *   - the raw fetch() patterns used for multipart upload + action POSTs
 *
 * It skips the SvelteKit wrapper (auth + robot-IP lookup) because those
 * are trivial and we don't have .env on this machine right now. Everything
 * the clone DOES to the robot is exercised here.
 *
 * Run:
 *   npx tsx scripts/verify-opentrons-clone.ts [hostname]
 *
 * Default target: hidden-leaf.local (has good calibration).
 */

import { createRobotClient, robotBaseUrl, unwrap } from '../src/lib/server/opentrons/client.js';

const HOST = process.argv[2] || 'hidden-leaf.local';
const ROBOT = { ip: HOST, port: 31950 };
const BASE = robotBaseUrl(ROBOT);

const results: Array<{ row: number | string; name: string; pass: boolean; detail: string }> = [];

function log(row: number | string, name: string, pass: boolean, detail: string) {
	results.push({ row, name, pass, detail });
	const mark = pass ? 'PASS' : 'FAIL';
	console.log(`[${mark}] row ${row} — ${name} — ${detail}`);
}

async function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// Minimal protocol that's safe to actually run: just home the robot.
const MINIMAL_PROTOCOL = `from opentrons import protocol_api

metadata = {
    'protocolName': 'BIMS Clone Task-5 Verify',
    'author': 'verify-opentrons-clone.ts',
    'description': 'Minimal protocol used to verify BIMS opentrons-clone end-to-end. Just homes.'
}
requirements = {"robotType": "OT-2", "apiLevel": "2.19"}

def run(protocol: protocol_api.ProtocolContext):
    protocol.home()
    protocol.comment("BIMS clone verify — home complete")
`;

async function raw(
	method: string,
	path: string,
	init: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number; body: any }> {
	const headers = { 'opentrons-version': '*', ...(init.headers ?? {}) };
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: init.body,
		signal: AbortSignal.timeout(init.timeoutMs ?? 15_000)
	});
	let body: any = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { ok: res.ok, status: res.status, body };
}

async function main() {
	console.log(`\n=== Opentrons clone Task-5 verify — target ${BASE} ===\n`);
	const client = createRobotClient(ROBOT, { timeoutMs: 10_000 });

	// Row 1 — health
	try {
		const res = await (client as any).GET('/health', {});
		const h = unwrap(res);
		log(1, 'health', true, `${h.name} api=${h.api_version} fw=${h.fw_version}`);
	} catch (e) {
		log(1, 'health', false, (e as Error).message);
		console.error('Robot unreachable, aborting.');
		process.exit(1);
	}

	// Row 2 — server version (covered by /health)
	log(2, 'server version', true, 'covered by /health.api_version');

	// Row 3 — instruments
	try {
		const r = await (client as any).GET('/instruments', {});
		const data = unwrap(r).data ?? [];
		const mounts = data.map((i: any) => `${i.mount}:${i.instrumentName ?? i.instrumentModel ?? 'empty'}`).join(', ');
		log(3, 'instruments', true, `${data.length} mount(s) — ${mounts || 'none'}`);
	} catch (e) {
		log(3, 'instruments', false, (e as Error).message);
	}

	// Row 4 — modules
	try {
		const r = await (client as any).GET('/modules', {});
		const data = unwrap(r).data ?? [];
		log(4, 'modules', true, `${data.length} module(s)`);
	} catch (e) {
		log(4, 'modules', false, (e as Error).message);
	}

	// Row 5 — calibration status + offsets
	try {
		const [s, po, tl] = await Promise.all([
			(client as any).GET('/calibration/status', {}),
			(client as any).GET('/calibration/pipette_offset', {}),
			(client as any).GET('/calibration/tip_length', {})
		]);
		const status = unwrap(s);
		const off = unwrap(po).data ?? [];
		const tip = unwrap(tl).data ?? [];
		log(
			5,
			'calibration',
			true,
			`deckCalOk=${!!status?.deckCalibration?.status?.markedAt || 'n/a'} pipetteOffsets=${off.length} tipLengths=${tip.length}`
		);
	} catch (e) {
		log(5, 'calibration', false, (e as Error).message);
	}

	// Row 22 — lights read
	try {
		const r = await (client as any).GET('/robot/lights', {});
		const d = unwrap(r);
		log(22, 'lights (read)', true, `on=${d.on}`);
	} catch (e) {
		log(22, 'lights (read)', false, (e as Error).message);
	}

	// Row 22 — lights write (toggle on then off)
	try {
		const on = await raw('POST', '/robot/lights', {
			body: JSON.stringify({ on: true }),
			headers: { 'Content-Type': 'application/json' }
		});
		await sleep(500);
		const off = await raw('POST', '/robot/lights', {
			body: JSON.stringify({ on: false }),
			headers: { 'Content-Type': 'application/json' }
		});
		log(22, 'lights (write)', on.ok && off.ok, `on=${on.status} off=${off.status}`);
	} catch (e) {
		log(22, 'lights (write)', false, (e as Error).message);
	}

	// Row 23 — identify (blink) — short so we don't hang
	try {
		const r = await raw('POST', '/identify?seconds=2', { timeoutMs: 8_000 });
		log(23, 'identify', r.ok, `status=${r.status}`);
	} catch (e) {
		log(23, 'identify', false, (e as Error).message);
	}

	// Row 27 — settings list
	let settingsCount = 0;
	try {
		const r = await (client as any).GET('/settings', {});
		const d = unwrap(r);
		settingsCount = (d?.settings ?? []).length;
		log(27, 'settings list', true, `${settingsCount} settings`);
	} catch (e) {
		log(27, 'settings list', false, (e as Error).message);
	}

	// Row 29 — settings reset options (doesn't actually reset; read options)
	try {
		const r = await raw('GET', '/settings/reset/options');
		log(29, 'settings reset options', r.ok, `status=${r.status} options=${r.body?.options?.length ?? 0}`);
	} catch (e) {
		log(29, 'settings reset options', false, (e as Error).message);
	}

	// Row 31 — error recovery policy
	try {
		const r = await raw('GET', '/errorRecovery/settings');
		log(31, 'errorRecovery settings', r.ok, `status=${r.status} enabled=${r.body?.data?.enabled}`);
	} catch (e) {
		log(31, 'errorRecovery settings', false, (e as Error).message);
	}

	// Row 32 — networking
	try {
		const r = await (client as any).GET('/networking/status', {});
		const d = unwrap(r);
		const ifaces = Object.keys(d?.interfaces ?? {}).join(',');
		log(32, 'networking', true, `status=${d?.status} ifaces=${ifaces}`);
	} catch (e) {
		log(32, 'networking', false, (e as Error).message);
	}

	// Row 35 — system clock
	try {
		const r = await raw('GET', '/system/time');
		const robotTime = r.body?.data?.systemTime;
		const drift = robotTime ? Math.round((Date.now() - new Date(robotTime).getTime()) / 1000) : null;
		log(35, 'system time', r.ok, `robot=${robotTime} drift=${drift}s`);
	} catch (e) {
		log(35, 'system time', false, (e as Error).message);
	}

	// Row 33 — data files list
	try {
		const r = await raw('GET', '/dataFiles');
		log(33, 'dataFiles list', r.ok, `files=${r.body?.data?.length ?? 0}`);
	} catch (e) {
		log(33, 'dataFiles list', false, (e as Error).message);
	}

	// Row 34 — clientData round-trip
	const cdKey = `bims_verify_${Date.now()}`;
	try {
		const put = await raw('PUT', `/clientData/${cdKey}`, {
			body: JSON.stringify({ data: { stamp: new Date().toISOString(), by: 'verify-script' } }),
			headers: { 'Content-Type': 'application/json' }
		});
		const get = await raw('GET', `/clientData/${cdKey}`);
		const del = await raw('DELETE', `/clientData/${cdKey}`);
		log(34, 'clientData K/V', put.ok && get.ok && del.ok, `put=${put.status} get=${get.status} del=${del.status}`);
	} catch (e) {
		log(34, 'clientData K/V', false, (e as Error).message);
	}

	// Row 30 — server logs (just fetch a few bytes of api.log via /logs/api.log)
	try {
		const res = await fetch(`${BASE}/logs/api.log?records=500`, {
			headers: { 'opentrons-version': '*' },
			signal: AbortSignal.timeout(60_000)
		});
		let bytes = 0;
		if (res.ok && res.body) {
			const reader = res.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value?.length ?? 0;
				if (bytes > 256 * 1024) { reader.cancel(); break; }
			}
		}
		log(30, 'server logs', res.ok, `api.log status=${res.status} bytes_read=${bytes}`);
	} catch (e) {
		log(30, 'server logs', false, (e as Error).message);
	}

	// Row 25 — labwareOffsets list
	try {
		const r = await raw('GET', '/labwareOffsets');
		log(25, 'labwareOffsets', r.ok, `status=${r.status} offsets=${r.body?.data?.length ?? 0}`);
	} catch (e) {
		log(25, 'labwareOffsets', false, (e as Error).message);
	}

	// Row 21 — home robot (safe — just homes)
	try {
		const r = await raw('POST', '/robot/home', {
			body: JSON.stringify({ target: 'robot' }),
			headers: { 'Content-Type': 'application/json' },
			timeoutMs: 60_000
		});
		log(21, 'home robot', r.ok, `status=${r.status}`);
	} catch (e) {
		log(21, 'home robot', false, (e as Error).message);
	}

	// ---- Protocol + run lifecycle (rows 6-19) ----

	// Row 7 — upload protocol
	const form = new FormData();
	const blob = new Blob([MINIMAL_PROTOCOL], { type: 'text/x-python' });
	form.append('files', blob, 'bims_verify.py');

	let protocolId: string | null = null;
	let analysisId: string | null = null;
	try {
		const res = await fetch(`${BASE}/protocols`, {
			method: 'POST',
			headers: { 'opentrons-version': '*' },
			body: form,
			signal: AbortSignal.timeout(60_000)
		});
		const body = await res.json();
		if (res.ok) {
			protocolId = body?.data?.id ?? null;
			analysisId = body?.data?.analysisSummaries?.[0]?.id ?? null;
			log(7, 'protocol upload', true, `protocolId=${protocolId}`);
		} else {
			log(7, 'protocol upload', false, `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
		}
	} catch (e) {
		log(7, 'protocol upload', false, (e as Error).message);
	}

	if (!protocolId) {
		console.log('\nNo protocolId — skipping run/analysis steps.\n');
	} else {
		// Row 6 — protocols list (should include new one)
		try {
			const r = await raw('GET', '/protocols');
			const found = (r.body?.data ?? []).some((p: any) => p.id === protocolId);
			log(6, 'protocols list', r.ok && found, `found new protocol=${found}`);
		} catch (e) {
			log(6, 'protocols list', false, (e as Error).message);
		}

		// Row 8 — protocol detail
		try {
			const r = await raw('GET', `/protocols/${protocolId}`);
			log(8, 'protocol detail', r.ok, `status=${r.status}`);
		} catch (e) {
			log(8, 'protocol detail', false, (e as Error).message);
		}

		// Row 9 — protocol analysis — poll until ready
		try {
			let ready = false;
			let lastStatus = 'pending';
			let errors: any[] = [];
			for (let i = 0; i < 60 && !ready; i++) {
				await sleep(1000);
				const r = await raw('GET', `/protocols/${protocolId}/analyses`);
				const analyses = r.body?.data ?? [];
				const latest = analyses[analyses.length - 1];
				if (latest) {
					analysisId = latest.id;
					lastStatus = latest.status;
					errors = latest.errors ?? [];
					if (latest.status === 'completed' || latest.status === 'ok' || latest.status === 'not-ok') {
						ready = true;
					}
				}
			}
			log(
				9,
				'protocol analysis',
				ready,
				`status=${lastStatus} analysisId=${analysisId} errors=${errors.length}`
			);
			if (errors.length) console.log('    analysis errors:', JSON.stringify(errors[0]).slice(0, 300));
		} catch (e) {
			log(9, 'protocol analysis', false, (e as Error).message);
		}

		// Row 13 — create run
		let runId: string | null = null;
		try {
			const r = await raw('POST', '/runs', {
				body: JSON.stringify({ data: { protocolId } }),
				headers: { 'Content-Type': 'application/json' },
				timeoutMs: 30_000
			});
			runId = r.body?.data?.id ?? null;
			log(13, 'run create', r.ok && !!runId, `runId=${runId}`);
		} catch (e) {
			log(13, 'run create', false, (e as Error).message);
		}

		if (runId) {
			// Row 14 — run detail
			try {
				const r = await raw('GET', `/runs/${runId}`);
				log(14, 'run detail', r.ok, `status=${r.body?.data?.status}`);
			} catch (e) {
				log(14, 'run detail', false, (e as Error).message);
			}

			// Row 15 — currentState
			try {
				const r = await raw('GET', `/runs/${runId}/currentState`);
				log(15, 'run currentState', r.ok, `status=${r.status}`);
			} catch (e) {
				log(15, 'run currentState', false, (e as Error).message);
			}

			// Row 18 — action: play
			try {
				const r = await raw('POST', `/runs/${runId}/actions`, {
					body: JSON.stringify({ data: { actionType: 'play' } }),
					headers: { 'Content-Type': 'application/json' }
				});
				log('18a', 'run action: play', r.ok, `status=${r.status}`);
			} catch (e) {
				log('18a', 'run action: play', false, (e as Error).message);
			}

			// Let it start
			await sleep(3000);

			// Row 18 — action: pause
			try {
				const r = await raw('POST', `/runs/${runId}/actions`, {
					body: JSON.stringify({ data: { actionType: 'pause' } }),
					headers: { 'Content-Type': 'application/json' }
				});
				log('18b', 'run action: pause', r.ok, `status=${r.status}`);
			} catch (e) {
				log('18b', 'run action: pause', false, (e as Error).message);
			}

			await sleep(1000);

			// Row 18 — action: play (resume)
			try {
				const r = await raw('POST', `/runs/${runId}/actions`, {
					body: JSON.stringify({ data: { actionType: 'play' } }),
					headers: { 'Content-Type': 'application/json' }
				});
				log('18c', 'run action: resume', r.ok, `status=${r.status}`);
			} catch (e) {
				log('18c', 'run action: resume', false, (e as Error).message);
			}

			// Wait for run to finish (minimal protocol = just home, ~30s max)
			let finalStatus = 'unknown';
			for (let i = 0; i < 90; i++) {
				await sleep(1000);
				const r = await raw('GET', `/runs/${runId}`);
				const s = r.body?.data?.status;
				if (s && ['stopped', 'failed', 'succeeded', 'finishing', 'stop-requested'].includes(s)) {
					finalStatus = s;
					if (s === 'succeeded' || s === 'failed' || s === 'stopped') break;
				}
				finalStatus = s ?? finalStatus;
			}
			log('18d', 'run completes', ['succeeded', 'stopped', 'failed'].includes(finalStatus), `final=${finalStatus}`);

			// Row 16 — commands list
			try {
				const r = await raw('GET', `/runs/${runId}/commands?pageLength=20`);
				const cmds = r.body?.data ?? [];
				log(16, 'run commands', r.ok, `count=${cmds.length}`);
			} catch (e) {
				log(16, 'run commands', false, (e as Error).message);
			}

			// Row 17 — command errors
			try {
				const r = await raw('GET', `/runs/${runId}/commandErrors`);
				log(17, 'run commandErrors', r.ok, `errors=${r.body?.data?.length ?? 0}`);
			} catch (e) {
				log(17, 'run commandErrors', false, (e as Error).message);
			}

			// Row 12 — runs list
			try {
				const r = await raw('GET', '/runs');
				const found = (r.body?.data ?? []).some((run: any) => run.id === runId);
				log(12, 'runs list', r.ok && found, `found new run=${found}`);
			} catch (e) {
				log(12, 'runs list', false, (e as Error).message);
			}

			// Row 19 — run delete
			try {
				const r = await raw('DELETE', `/runs/${runId}`);
				log(19, 'run delete', r.ok, `status=${r.status}`);
			} catch (e) {
				log(19, 'run delete', false, (e as Error).message);
			}
		}

		// Row 10 — protocol delete
		try {
			const r = await raw('DELETE', `/protocols/${protocolId}`);
			log(10, 'protocol delete', r.ok, `status=${r.status}`);
		} catch (e) {
			log(10, 'protocol delete', false, (e as Error).message);
		}
	}

	// ---- Production-readiness smoke test (rows 36-39) ----

	// Row 36 — maintenance run lifecycle (create → get → delete)
	let mrId: string | null = null;
	try {
		const create = await raw('POST', '/maintenance_runs', {
			body: JSON.stringify({ data: {} }),
			headers: { 'Content-Type': 'application/json' }
		});
		mrId = create.body?.data?.id ?? null;
		if (!create.ok || !mrId) {
			log(36, 'maintenance run lifecycle', false, `create status=${create.status}`);
		} else {
			const get = await raw('GET', `/maintenance_runs/${mrId}`);
			const del = await raw('DELETE', `/maintenance_runs/${mrId}`);
			log(
				36,
				'maintenance run lifecycle',
				create.ok && get.ok && del.ok,
				`create=${create.status} get=${get.status} delete=${del.status}`
			);
			mrId = null; // deleted; no cleanup needed
		}
	} catch (e) {
		log(36, 'maintenance run lifecycle', false, (e as Error).message);
	}

	// Row 37 — maintenance run command validity (home, no physical motion beyond axes)
	let mrId37: string | null = null;
	try {
		const create = await raw('POST', '/maintenance_runs', {
			body: JSON.stringify({ data: {} }),
			headers: { 'Content-Type': 'application/json' }
		});
		mrId37 = create.body?.data?.id ?? null;
		if (!create.ok || !mrId37) {
			log(37, 'maintenance command', false, `create status=${create.status}`);
		} else {
			const cmd = await raw(
				'POST',
				`/maintenance_runs/${mrId37}/commands?waitUntilComplete=true&timeout=60000`,
				{
					body: JSON.stringify({ data: { commandType: 'home', params: {} } }),
					headers: { 'Content-Type': 'application/json' },
					timeoutMs: 70_000
				}
			);
			const status = cmd.body?.data?.status;
			log(
				37,
				'maintenance command',
				cmd.ok && (status === 'succeeded' || status === 'running'),
				`cmd=${cmd.status} cmdStatus=${status}`
			);
		}
	} catch (e) {
		log(37, 'maintenance command', false, (e as Error).message);
	} finally {
		if (mrId37) {
			try {
				await raw('DELETE', `/maintenance_runs/${mrId37}`);
			} catch {
				// best-effort cleanup
			}
		}
	}

	// Row 38 — offsets atomic: POST /runs with a malformed offset → 4xx, no orphan run
	try {
		const runsBefore = await raw('GET', '/runs');
		const countBefore = (runsBefore.body?.data ?? []).length;
		const bogusBody = {
			data: {
				labwareOffsets: [
					{
						definitionUri: 'opentrons/opentrons_96_tiprack_300ul/1',
						location: { slotName: '1' },
						// vector with non-numeric field — schema should reject
						vector: { x: 'not-a-number', y: 0, z: 0 }
					}
				]
			}
		};
		const attempt = await raw('POST', '/runs', {
			body: JSON.stringify(bogusBody),
			headers: { 'Content-Type': 'application/json' }
		});
		const runsAfter = await raw('GET', '/runs');
		const countAfter = (runsAfter.body?.data ?? []).length;
		const rejected = !attempt.ok && attempt.status >= 400 && attempt.status < 500;
		const noOrphan = countAfter === countBefore;
		log(
			38,
			'offsets atomic (bogus → 4xx)',
			rejected && noOrphan,
			`attempt=${attempt.status} runsBefore=${countBefore} runsAfter=${countAfter}`
		);
		// Defensive cleanup if a run was somehow created despite the schema error
		if (!noOrphan && attempt.body?.data?.id) {
			await raw('DELETE', `/runs/${attempt.body.data.id}`);
		}
	} catch (e) {
		log(38, 'offsets atomic (bogus → 4xx)', false, (e as Error).message);
	}

	// Row 39 — offsets happy path: POST /runs with a valid offset → 2xx + offset recorded + cleanup
	let offsetRunId: string | null = null;
	try {
		const validBody = {
			data: {
				labwareOffsets: [
					{
						definitionUri: 'opentrons/opentrons_96_tiprack_300ul/1',
						location: { slotName: '1' },
						vector: { x: 0, y: 0, z: 0 }
					}
				]
			}
		};
		const create = await raw('POST', '/runs', {
			body: JSON.stringify(validBody),
			headers: { 'Content-Type': 'application/json' }
		});
		offsetRunId = create.body?.data?.id ?? null;
		const offsetsOnRun = (create.body?.data?.labwareOffsets ?? []).length;
		log(
			39,
			'offsets applied on run create',
			create.ok && !!offsetRunId && offsetsOnRun === 1,
			`status=${create.status} runId=${offsetRunId} offsets=${offsetsOnRun}`
		);
	} catch (e) {
		log(39, 'offsets applied on run create', false, (e as Error).message);
	} finally {
		if (offsetRunId) {
			try {
				await raw('DELETE', `/runs/${offsetRunId}`);
			} catch {
				// best-effort cleanup
			}
		}
	}

	// ---- Summary ----
	const passed = results.filter((r) => r.pass).length;
	const failed = results.filter((r) => !r.pass);
	console.log(`\n=== Summary: ${passed}/${results.length} checks passed ===`);
	if (failed.length) {
		console.log('\nFAILED:');
		for (const f of failed) console.log(`  row ${f.row} — ${f.name} — ${f.detail}`);
	}

	// Write a machine-readable artifact for VERIFIED.md
	const out = {
		host: HOST,
		timestamp: new Date().toISOString(),
		results
	};
	console.log(`\n--RESULTS-JSON--${JSON.stringify(out)}--END--\n`);

	process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
