/**
 * OT2-TAILNET-5 S1: the run-lifecycle verbs and parsers, moved out of the fill
 * page servers / protocol-freshness.ts / proxy.ts. Parity is checked against
 * the OLD code, kept here verbatim as `legacy*` references, on fixtures in the
 * shape the OT-2 robot-server returns (src/lib/opentrons/__fixtures__/run).
 */
import { describe, it, expect, vi } from 'vitest';
import {
	runVerb,
	verbRoute,
	parseTipTracker,
	parseFilledWells,
	cartsFilledFromWells,
	currentRunFromList,
	buildProtocolForm,
	browserTransport,
	startRunSequence,
	observeRunFinished,
	observeRunStopped,
	sessionVerb,
	startRunTwoPhase,
	stopRunTwoPhase,
	finishRunTwoPhase,
	validUploadedResult,
	NO_RETRY_VERBS,
	LIFECYCLE_VERBS,
	PRE_ANALYZED_FIELD,
	FINISH_COMMANDS_PAGING,
	FILLED_WELLS_PAGING,
	type Ot2Transport,
	type StartRunSteps,
	type RunCommand
} from './ot2-protocol';
import finishPage from './__fixtures__/run/commands-finish.json';
import waxAbort from './__fixtures__/run/commands-wax-abort.json';
import analysesList from './__fixtures__/run/analyses-list.json';
import analysisDetail from './__fixtures__/run/analysis-detail.json';

// ── helpers ────────────────────────────────────────────────────────────────

const jres = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; path: string; body?: unknown; opts?: { timeoutMs?: number } };
function mockTransport(route: (c: Call) => Response | Promise<Response>): Ot2Transport & { calls: Call[] } {
	const calls: Call[] = [];
	const go = async (c: Call) => {
		calls.push(c);
		return route(c);
	};
	return {
		calls,
		get: (path, opts) => go({ method: 'GET', path, opts }),
		post: (path, body, opts) => go({ method: 'POST', path, body, opts }),
		delete: (path, opts) => go({ method: 'DELETE', path, opts })
	};
}

// The OLD recordRunFinished tip loop (wax + reagent were identical).
function legacyTipParse(commands: Array<{ commandType: string; params?: { message?: string } }>) {
	let nextTipIndex: number | null = null;
	let pickUpTipCount = 0;
	for (const cmd of commands) {
		if (cmd.commandType === 'pickUpTip') pickUpTipCount += 1;
		if (cmd.commandType === 'comment' && cmd.params?.message) {
			const m = cmd.params.message.match(/TIP TRACKER:[\s\S]*?\(index (\d+)\)/);
			if (m) nextTipIndex = parseInt(m[1], 10);
		}
	}
	return { nextTipIndex, pickUpTipCount };
}

// The OLD cartsFilledPerRobotLog body (one page, without the paging loop).
function legacyCartsFilled(cmds: Array<{ commandType: string; params?: { message?: string } }>, pp: any): Set<number> {
	const filled = new Set<number>();
	const wellsPerCart = new Map<number, Set<string>>();
	for (const c of cmds) {
		if (c.commandType !== 'comment') continue;
		const m = c.params?.message?.match(/Dispensed [\d.]+uL into well ([A-X])(\d+)/);
		if (!m) continue;
		const row = m[1];
		const col = parseInt(m[2], 10);
		const carrier = Math.floor((col - 1) / 8);
		const band = Math.floor('XWVUTSRQPONMLKJIHGFEDCBA'.indexOf(row) / 3);
		const cart = carrier * 8 + band + 1;
		if (!wellsPerCart.has(cart)) wellsPerCart.set(cart, new Set());
		wellsPerCart.get(cart)!.add(row + col);
	}
	const patterns = ['row_pattern_0', 'row_pattern_1', 'row_pattern_2'].filter((k) => (pp ?? {})[k] !== false).length || 3;
	const expected = 4 * patterns;
	for (const [cart, wells] of wellsPerCart) if (wells.size >= expected) filled.add(cart);
	return filled;
}

// ── parsers ────────────────────────────────────────────────────────────────

describe('tip-tracker parse (was inline in both recordRunFinished)', () => {
	it('matches the old loop on a recorded-shape commands page', () => {
		const cmds = finishPage.data as RunCommand[];
		expect(parseTipTracker(cmds)).toEqual(legacyTipParse(cmds as any));
		expect(parseTipTracker(cmds)).toEqual({ nextTipIndex: 29, pickUpTipCount: 5 });
	});
	it('no tracker comments → null index, pick-ups counted', () => {
		const cmds = [{ commandType: 'pickUpTip' }, { commandType: 'comment', params: { message: 'hello' } }] as RunCommand[];
		expect(parseTipTracker(cmds)).toEqual(legacyTipParse(cmds as any));
		expect(parseTipTracker(cmds)).toEqual({ nextTipIndex: null, pickUpTipCount: 1 });
	});
	it('empty / missing → the old "fetch failed" defaults', () => {
		expect(parseTipTracker([])).toEqual({ nextTipIndex: null, pickUpTipCount: 0 });
		expect(parseTipTracker(undefined as any)).toEqual({ nextTipIndex: null, pickUpTipCount: 0 });
	});
});

describe('filled-well parse (was cartsFilledPerRobotLog)', () => {
	const cmds = waxAbort.commands as RunCommand[];
	it('first-seen order, de-duplicated', () => {
		const wells = parseFilledWells(cmds);
		expect(wells.slice(0, 4)).toEqual(['X2', 'X4', 'X6', 'X8']);
		expect(wells).toHaveLength(17); // 12 (cart 1) + 5 (cart 2 partial); the X2 retry is not re-counted
	});
	it('cart arithmetic matches the old code for default, reduced and all-off row patterns', () => {
		for (const pp of [null, {}, { row_pattern_2: false }, { row_pattern_0: false, row_pattern_1: false, row_pattern_2: false }]) {
			expect(new Set(cartsFilledFromWells(parseFilledWells(cmds), pp as any))).toEqual(legacyCartsFilled(cmds as any, pp));
		}
		expect(cartsFilledFromWells(parseFilledWells(cmds), null)).toEqual([1]); // cart 2 is only partial
	});
	it('only fully-filled carts count; malformed well tokens are ignored', () => {
		expect(cartsFilledFromWells(['X2', 'bogus', 'Z9'], null)).toEqual([]);
	});
});

// ── run.* verbs ────────────────────────────────────────────────────────────

describe('run.commands paging (exactly the old loops)', () => {
	it('finish read: one cursor=0&pageLength=10000 page, only commandType + params kept', async () => {
		const t = mockTransport(() => jres(200, finishPage));
		const r = await runVerb(t, 'run.commands', { rid: 'run-fin', ...FINISH_COMMANDS_PAGING });
		expect(t.calls.map((c) => c.path)).toEqual(['/runs/run-fin/commands?cursor=0&pageLength=10000']);
		expect(r.status).toBe(200);
		const commands = (r.body as any).commands;
		expect(commands).toHaveLength(finishPage.data.length);
		expect(Object.keys(commands[0]).sort()).toEqual(['commandType', 'params']);
	});
	it('wax read: pages of 999, advancing the cursor, at most 5 pages', async () => {
		const all = Array.from({ length: 2500 }, (_, i) => ({ commandType: 'comment', params: { message: `c${i}` } }));
		const t = mockTransport((c) => {
			const q = new URL('http://x' + c.path).searchParams;
			const cursor = Number(q.get('cursor'));
			const len = Number(q.get('pageLength'));
			return jres(200, { data: all.slice(cursor, cursor + len), meta: { totalLength: all.length } });
		});
		const r = await runVerb(t, 'run.commands', { rid: 'r1', ...FILLED_WELLS_PAGING });
		expect(t.calls.map((c) => c.path)).toEqual([
			'/runs/r1/commands?cursor=0&pageLength=999',
			'/runs/r1/commands?cursor=999&pageLength=999',
			'/runs/r1/commands?cursor=1998&pageLength=999'
		]);
		expect((r.body as any).commands).toHaveLength(2500);
	});
	it('a non-OK page ends the read with what was collected (the old `break`)', async () => {
		let n = 0;
		const t = mockTransport(() => (n++ === 0 ? jres(200, { data: [{ commandType: 'pickUpTip' }], meta: { totalLength: 5 } }) : jres(500, {})));
		const r = await runVerb(t, 'run.commands', { rid: 'r1', ...FILLED_WELLS_PAGING });
		expect(r.status).toBe(200);
		expect((r.body as any).commands).toHaveLength(1);
		expect((r.body as any).robotStatus).toBe(500);
	});
	it('a thrown read is a 502 (the old catch → revert-all / empty parse)', async () => {
		const t = mockTransport(() => {
			throw new TypeError('fetch failed');
		});
		const r = await runVerb(t, 'run.commands', { rid: 'r1' });
		expect(r.status).toBe(502);
	});
});

describe('run.stop — the stopRobotRun rule', () => {
	const stopWith = (res: Response | Error) =>
		mockTransport(() => {
			if (res instanceof Error) throw res;
			return res;
		});
	it('posts actionType stop', async () => {
		const t = stopWith(jres(201, {}));
		const r = await runVerb(t, 'run.stop', { rid: 'r9' });
		expect(t.calls[0]).toMatchObject({ method: 'POST', path: '/runs/r9/actions', body: { data: { actionType: 'stop' } } });
		expect(r).toEqual({ status: 200, body: { stopped: true, warning: null } });
	});
	it.each([
		[404, {}],
		[409, {}],
		[400, { errors: [{ detail: 'Run is not found' }] }],
		[422, { errors: [{ detail: 'Action not allowed in state succeeded' }] }],
		[400, { errors: [{ detail: 'Run has already reached a terminal state' }] }]
	])('%s %j → already terminal = ok, no warning', async (status, body) => {
		const r = await runVerb(stopWith(jres(status, body)), 'run.stop', { rid: 'r9' });
		expect(r.status).toBe(200);
		expect((r.body as any).warning).toBeNull();
		expect((r.body as any).alreadyTerminal).toBe(true);
	});
	it('another robot error → a warning (never a failure)', async () => {
		const r = await runVerb(stopWith(jres(500, { errors: [{ detail: 'boom' }] })), 'run.stop', { rid: 'r9' });
		expect(r.status).toBe(200);
		expect((r.body as any).warning).toBe("Couldn't stop the run on the robot (boom) — confirm on the device.");
	});
	it('unreachable → the old unreachable warning', async () => {
		const r = await runVerb(stopWith(new Error('fetch failed')), 'run.stop', { rid: 'r9' });
		expect((r.body as any).warning).toBe("Couldn't reach the robot to stop the run (fetch failed) — confirm on the device.");
	});
	it('observeRunStopped turns the verb result into the confirm observation', async () => {
		const t = mockTransport((c) => (c.method === 'POST' ? jres(409, {}) : jres(200, { data: waxAbort.commands, meta: { totalLength: waxAbort.commands.length } })));
		const obs = await observeRunStopped((v, a) => runVerb(t, v, a), 'r9', { readFilledWells: true });
		expect(obs.stopWarning).toBeNull();
		expect(obs.filledWells).toEqual(parseFilledWells(waxAbort.commands as RunCommand[]));
		expect(t.calls[1].path).toBe('/runs/r9/commands?cursor=0&pageLength=999');
	});
});

describe('run.create / run.list', () => {
	it('create: same body as startRun; RTP only when present', async () => {
		const t = mockTransport(() => jres(201, { data: { id: 'run-new' } }));
		expect(await runVerb(t, 'run.create', { protocolId: 'p1', runTimeParameterValues: { cartridges: 12 } })).toEqual({
			status: 200,
			body: { opentronsRunId: 'run-new' }
		});
		expect(t.calls[0].body).toEqual({ data: { protocolId: 'p1', runTimeParameterValues: { cartridges: 12 } } });
		await runVerb(t, 'run.create', { protocolId: 'p1', runTimeParameterValues: {} });
		expect(t.calls[1].body).toEqual({ data: { protocolId: 'p1' } });
	});
	it('create: robot error → the old message', async () => {
		const t = mockTransport(() => jres(422, { errors: [{ detail: 'bad RTP' }] }));
		const r = await runVerb(t, 'run.create', { protocolId: 'p1' });
		expect(r.status).toBe(502);
		expect((r.body as any).message).toBe("Couldn't create run on robot: bad RTP");
	});
	it('list: links.current names the current run', async () => {
		const body = {
			data: [
				{ id: 'old', status: 'succeeded', protocolId: 'p0', createdAt: '2026-09-20T00:00:00Z' },
				{ id: 'cur', status: 'running', protocolId: 'p1', createdAt: '2026-09-21T00:00:00Z', current: true }
			],
			links: { current: { href: '/runs/cur' } }
		};
		expect(currentRunFromList(body)?.id).toBe('cur');
		const r = await runVerb(mockTransport(() => jres(200, body)), 'run.list', {});
		expect((r.body as any).currentRunId).toBe('cur');
		expect((r.body as any).current).toMatchObject({ id: 'cur', status: 'running', protocolId: 'p1' });
		expect(currentRunFromList({ data: [] })).toBeNull();
	});
});

describe('run.ensureFresh — stale-bundle detection (was bundledDefsMatchMongo)', () => {
	const robot = (detail: unknown = analysisDetail) =>
		mockTransport((c) => (c.path.endsWith('/analyses') ? jres(200, analysesList) : jres(200, detail)));
	const wells = { gen4deck_v2: { A1: { x: 10.5, y: 20.25, z: 3.0 }, A2: { x: 19.5, y: 20.25, z: 3.0 } } };

	it('fresh when every BIMS well matches; reads the LAST completed analysis', async () => {
		const t = robot();
		const r = await runVerb(t, 'run.ensureFresh', { protocolId: 'pid', expectedWells: wells });
		expect(r).toEqual({ status: 200, body: { ok: true, detail: '1 BIMS labware defs verified current' } });
		expect(t.calls.map((c) => c.path)).toEqual(['/protocols/pid/analyses', '/protocols/pid/analyses/an-new']);
	});
	it('a moved well is stale, with the old detail text', async () => {
		const moved = { gen4deck_v2: { ...wells.gen4deck_v2, A2: { x: 19.6, y: 20.25, z: 3.0 } } };
		const r = await runVerb(robot(), 'run.ensureFresh', { protocolId: 'pid', expectedWells: moved });
		expect(r.body).toEqual({ ok: false, detail: 'gen4deck_v2 A2 bundled (19.5,20.25,3) != current (19.6,20.25,3)' });
	});
	it('a well missing from the bundle is stale', async () => {
		const extra = { gen4deck_v2: { ...wells.gen4deck_v2, B1: { x: 1, y: 1, z: 1 } } };
		expect((await runVerb(robot(), 'run.ensureFresh', { protocolId: 'pid', expectedWells: extra })).body).toEqual({
			ok: false,
			detail: 'gen4deck_v2 B1 missing from bundled def'
		});
	});
	it('no BIMS labware in the analysis is stale; analysis errors / failures are 502 (→ "could not verify")', async () => {
		expect((await runVerb(robot(), 'run.ensureFresh', { protocolId: 'pid', expectedWells: { other: {} } })).body).toEqual({
			ok: false,
			detail: 'analysis resolved no BIMS-managed labware'
		});
		const withErr = { data: { ...analysisDetail.data, errors: [{ detail: 'x' }] } };
		const r = await runVerb(robot(withErr), 'run.ensureFresh', { protocolId: 'pid', expectedWells: wells });
		expect(r).toEqual({ status: 502, body: { message: 'protocol analysis completed with errors' } });
		const failed = mockTransport(() => jres(200, { data: [{ id: 'a', status: 'failed' }] }));
		expect((await runVerb(failed, 'run.ensureFresh', { protocolId: 'pid', expectedWells: wells })).body).toEqual({
			message: 'protocol analysis failed'
		});
	});
});

// ── upload: FormData on the transport ──────────────────────────────────────

describe('run.uploadProtocol', () => {
	const bundle = {
		fileName: 'wax_filling.py',
		fileContent: 'from opentrons import protocol_api\n',
		labware: [{ fileName: 'gen4deck_v2.json', json: '{"parameters":{"loadName":"gen4deck_v2"}}' }]
	};

	it('posts a FormData (the .py first, then each labware JSON) with the long timeout, then polls the analysis', async () => {
		vi.useFakeTimers();
		const t = mockTransport((c) => {
			if (c.method === 'POST') return jres(201, { data: { id: 'proto-1' } });
			if (c.path.endsWith('/analyses')) return jres(200, { data: [{ id: 'an-1', status: 'completed' }] });
			return jres(200, analysisDetail);
		});
		const p = runVerb(t, 'run.uploadProtocol', bundle);
		await vi.runAllTimersAsync();
		const r = await p;
		vi.useRealTimers();
		const post = t.calls[0];
		expect(post.path).toBe('/protocols');
		expect(post.body).toBeInstanceOf(FormData);
		expect(post.opts?.timeoutMs).toBe(110_000);
		const files = (post.body as FormData).getAll('files') as File[];
		expect(files.map((f) => f.name)).toEqual(['wax_filling.py', 'gen4deck_v2.json']);
		expect(await files[0].text()).toBe(bundle.fileContent);
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			opentronsProtocolId: 'proto-1',
			analysisStatus: 'completed',
			parametersSchema: analysisDetail.data.runTimeParameters,
			pipettesRequired: analysisDetail.data.pipettes
		});
	});

	it('a pre-analyzed answer (the queue bridge job) is returned as-is: no second analysis poll', async () => {
		const done = { opentronsProtocolId: 'proto-b', analysisStatus: 'completed', parametersSchema: null, labwareDefinitions: null, pipettesRequired: null };
		const t = mockTransport(() => jres(201, { data: { id: 'proto-b' }, [PRE_ANALYZED_FIELD]: done }));
		expect(await runVerb(t, 'run.uploadProtocol', bundle)).toEqual({ status: 200, body: done });
		expect(t.calls).toHaveLength(1);
	});

	it('fileB64 keeps the exact bytes', async () => {
		const bytes = new Uint8Array([0x23, 0x20, 0xc3, 0xa9, 0x0a]);
		const form = buildProtocolForm({ fileName: 'x.py', fileB64: Buffer.from(bytes).toString('base64'), labware: [] });
		const f = form.get('files') as File;
		expect(new Uint8Array(await f.arrayBuffer())).toEqual(bytes);
	});

	it('browserTransport sends FormData with no JSON content-type and no stringify', async () => {
		const seen: RequestInit[] = [];
		const fetchImpl = (async (_u: string, init: RequestInit) => {
			seen.push(init);
			return jres(201, {});
		}) as unknown as typeof fetch;
		const t = browserTransport('https://ot2-b14.example.ts.net/', fetchImpl);
		const fd = buildProtocolForm(bundle);
		await t.post('/protocols', fd, { timeoutMs: 110_000 });
		expect(seen[0].body).toBe(fd);
		expect(seen[0].headers).toEqual({ 'opentrons-version': '*' });
		await t.post('/runs', { a: 1 });
		expect(seen[1].body).toBe('{"a":1}');
		expect((seen[1].headers as any)['Content-Type']).toBe('application/json');
	});

	it('validUploadedResult accepts the verb result and rejects junk', () => {
		expect(validUploadedResult({ opentronsProtocolId: 'p-1', analysisStatus: 'completed' })).toMatchObject({ opentronsProtocolId: 'p-1' });
		expect(validUploadedResult({ opentronsProtocolId: '../x', analysisStatus: 'completed' })).toBeNull();
		expect(validUploadedResult({ opentronsProtocolId: 'p', analysisStatus: 'completed', parametersSchema: 'x' })).toBeNull();
		expect(validUploadedResult(null)).toBeNull();
	});
});

// ── line plumbing ──────────────────────────────────────────────────────────

describe('queue route + failover rules for the new verbs', () => {
	it('every lifecycle verb maps to POST /verb with the path params in the query', () => {
		for (const v of LIFECYCLE_VERBS) {
			const r = verbRoute(v, { rid: 'r 1', runId: 'm1' });
			expect(r.method).toBe('POST');
			expect(r.path).toBe(`/verb?verb=${encodeURIComponent(v)}&rid=r+1&runId=m1`);
		}
		expect(verbRoute('run.list', {}).path).toBe('/verb?verb=run.list');
	});
	it('create / upload / mx.command are never auto-retried; reads and stops are', () => {
		for (const v of ['run.create', 'run.uploadProtocol', 'mx.command'] as const) expect(NO_RETRY_VERBS.has(v)).toBe(true);
		for (const v of ['run.list', 'run.commands', 'run.ensureFresh', 'run.stop'] as const) expect(NO_RETRY_VERBS.has(v)).toBe(false);
	});
	it('mx.command posts the generic maintenance command', async () => {
		const t = mockTransport(() => jres(201, { data: { id: 'c1', status: 'succeeded' } }));
		const r = await runVerb(t, 'mx.command', { runId: 'mr1', commandType: 'moveToWell', params: { wellName: 'A1' } });
		expect(t.calls[0].path).toBe('/maintenance_runs/mr1/commands?waitUntilComplete=true&timeout=30000');
		expect(t.calls[0].body).toEqual({ data: { commandType: 'moveToWell', intent: 'setup', params: { wellName: 'A1' } } });
		expect(r).toEqual({ status: 200, body: { ok: true, command: { id: 'c1', status: 'succeeded' } } });
	});
});

// ── the start sequence (one order for both lines) ──────────────────────────

function startSteps(overrides: Partial<StartRunSteps> = {}, verbAnswers: Record<string, any> = {}) {
	const log: string[] = [];
	const confirms: any[] = [];
	const steps: StartRunSteps = {
		prepare: async () => {
			log.push('prepare');
			return { token: 'tok', processType: 'wax-filling', protocolId: 'p-cur', expectedWells: {}, runTimeParameterValues: { a: 1 } };
		},
		bundle: async () => {
			log.push('bundle');
			return { fileName: 'wax.py', fileContent: 'x', labware: [] };
		},
		recordResync: async () => {
			log.push('recordResync');
			return { runTimeParameterValues: { a: 2 } };
		},
		confirm: async (_t, obs) => {
			log.push(`confirm:${obs.phase}`);
			confirms.push(obs);
			return { success: true };
		},
		verb: async (v, a) => {
			log.push(v === 'run.action' ? `run.action:${a.action}` : v);
			if (v in verbAnswers) return typeof verbAnswers[v] === 'function' ? verbAnswers[v](a) : verbAnswers[v];
			if (v === 'run.ensureFresh') return { status: 200, body: { ok: true, detail: 'fresh' } };
			if (v === 'run.create') return { status: 200, body: { opentronsRunId: 'run-1' } };
			if (v === 'run.uploadProtocol') return { status: 200, body: { opentronsProtocolId: 'p-new', analysisStatus: 'completed' } };
			return { status: 200, body: { ok: true } };
		},
		...overrides
	};
	return { steps, log, confirms };
}

describe('startRunSequence', () => {
	it('fresh: check → create → confirm(created) → play → confirm(played); no upload', async () => {
		const { steps, log } = startSteps();
		const r = await startRunSequence(steps);
		expect(r).toEqual({ ok: true, opentronsRunId: 'run-1', result: { success: true } });
		expect(log).toEqual(['prepare', 'run.ensureFresh', 'run.create', 'confirm:created', 'run.action:play', 'confirm:played']);
	});
	it('stale: bundle → upload → record → verify (120 s wait) → create on the NEW protocol with its RTP', async () => {
		const seen: any[] = [];
		let n = 0;
		const { steps, log, confirms } = startSteps({}, {
			'run.ensureFresh': (a: any) => {
				seen.push(a);
				return n++ === 0 ? { status: 200, body: { ok: false, detail: 'moved' } } : { status: 200, body: { ok: true, detail: 'ok' } };
			},
			'run.create': (a: any) => {
				seen.push(a);
				return { status: 200, body: { opentronsRunId: 'run-2' } };
			}
		});
		const r = await startRunSequence(steps);
		expect(r.ok).toBe(true);
		expect(log).toEqual(['prepare', 'run.ensureFresh', 'bundle', 'run.uploadProtocol', 'recordResync', 'run.ensureFresh', 'run.create', 'confirm:created', 'run.action:play', 'confirm:played']);
		expect(seen[1]).toMatchObject({ protocolId: 'p-new', waitForCompletedMs: 120_000 });
		expect(seen[2]).toEqual({ protocolId: 'p-new', runTimeParameterValues: { a: 2 } });
		expect(confirms[0]).toEqual({ phase: 'created', opentronsRunId: 'run-2', protocolId: 'p-new' });
	});
	it('verify still stale → freshness failure with the old message, nothing created', async () => {
		const { steps, log } = startSteps({}, { 'run.ensureFresh': { status: 200, body: { ok: false, detail: 'moved' } } });
		const r = await startRunSequence(steps);
		expect(r).toEqual({
			ok: false,
			status: 502,
			error: "Deck-calibration freshness check failed: re-synced wax-filling protocol still doesn't match live calibration: moved"
		});
		expect(log).not.toContain('run.create');
		expect(log.at(-1)).toBe('confirm:failed');
	});
	it('create failure → the robot message; a lost answer keeps the intent (uncertain)', async () => {
		const { steps, confirms } = startSteps({}, {
			'run.create': { status: 502, body: { message: 'Direct link lost' }, lineLost: true }
		});
		const r = await startRunSequence(steps);
		expect(r).toMatchObject({ ok: false, error: 'Direct link lost' });
		expect(confirms.at(-1)).toMatchObject({ phase: 'failed', stage: 'create', uncertain: true });
	});
	it('play refused by the robot → the old wax message', async () => {
		const { steps } = startSteps({}, { 'run.action': { status: 409, body: { ok: false, detail: 'door open', conflict: true } } });
		const r = await startRunSequence(steps);
		expect(r).toMatchObject({
			ok: false,
			error: "Created run run-1 but couldn't start it: door open. Operator can play it from the device page."
		});
	});
	it('a prepare error stops before touching the robot', async () => {
		const { steps, log } = startSteps({ prepare: async () => ({ error: 'no deck', status: 400 }) });
		expect(await startRunSequence(steps)).toEqual({ ok: false, error: 'no deck', status: 400 });
		expect(log).toEqual([]);
	});
});

describe('finish observation', () => {
	it('reads one 10k page and parses the tips; a failed read = the empty parse', async () => {
		const ok = mockTransport(() => jres(200, finishPage));
		expect(await observeRunFinished((v, a) => runVerb(ok, v, a), 'run-fin', 'SUCCEEDED')).toEqual({
			finalStatus: 'succeeded',
			tips: { nextTipIndex: 29, pickUpTipCount: 5 }
		});
		const down = mockTransport(() => {
			throw new TypeError('fetch failed');
		});
		expect(await observeRunFinished((v, a) => runVerb(down, v, a), 'run-fin', 'failed')).toEqual({
			finalStatus: 'failed',
			tips: { nextTipIndex: null, pickUpTipCount: 0 }
		});
	});
});

// ── the tailnet drivers ────────────────────────────────────────────────────

function fakeSession(handler: (verb: string, args: any) => { status: number; body: unknown; dropLine?: boolean }) {
	const state = { transport: 'direct', fellBack: false };
	return {
		state,
		calls: [] as Array<{ verb: string; args: any }>,
		async call(verb: any, args: any) {
			this.calls.push({ verb, args });
			const r = handler(verb, args);
			if (r.dropLine) Object.assign(state, { transport: 'queue', fellBack: true });
			return jres(r.status, r.body);
		}
	};
}

describe('tailnet drivers', () => {
	it('sessionVerb flags the call that dropped the line', async () => {
		const s = fakeSession(() => ({ status: 502, body: { message: 'lost' }, dropLine: true }));
		const v = sessionVerb(s);
		expect(await v('run.create', {})).toMatchObject({ status: 502, lineLost: true });
		expect(await v('run.create', {})).toMatchObject({ lineLost: false }); // already on the queue
	});

	it('start posts the actions in order with line=tailnet and the obs as JSON', async () => {
		const posts: Array<{ action: string; fields: Record<string, string> }> = [];
		const s = fakeSession((verb) =>
			verb === 'run.ensureFresh'
				? { status: 200, body: { ok: true, detail: 'fresh' } }
				: verb === 'run.create'
					? { status: 200, body: { opentronsRunId: 'run-7' } }
					: { status: 200, body: { ok: true } }
		);
		const post = async (action: string, fields: Record<string, string>) => {
			posts.push({ action, fields });
			if (action === 'startPrepare') {
				return { ok: true as const, data: { token: 't1', processType: 'reagent-filling', protocolId: 'p1', expectedWells: {}, runTimeParameterValues: {} } };
			}
			return { ok: true as const, data: { success: true } };
		};
		const fd = new FormData();
		fd.set('runId', 'RUN1');
		fd.set('param_cartridges', '12');
		const r = await startRunTwoPhase({ form: fd, post, session: s });
		expect(r.ok).toBe(true);
		expect(posts.map((p) => p.action)).toEqual(['startPrepare', 'startConfirm', 'startConfirm']);
		expect(posts[0].fields).toMatchObject({ runId: 'RUN1', param_cartridges: '12', line: 'tailnet' });
		expect(JSON.parse(posts[1].fields.obs)).toEqual({ phase: 'created', opentronsRunId: 'run-7', protocolId: 'p1' });
		expect(posts[2].fields).toMatchObject({ runId: 'RUN1', token: 't1', line: 'tailnet' });
		expect(s.calls.map((c) => c.verb)).toEqual(['run.ensureFresh', 'run.create', 'run.action']);
	});

	it('finish and stop send only observations to the confirms', async () => {
		const posts: Array<{ action: string; fields: Record<string, string> }> = [];
		const post = async (action: string, fields: Record<string, string>) => {
			posts.push({ action, fields });
			return { ok: true as const, data: {} };
		};
		const s = fakeSession((verb) =>
			verb === 'run.commands'
				? { status: 200, body: { commands: verb && finishPage.data } }
				: { status: 200, body: { stopped: true, warning: null } }
		);
		await finishRunTwoPhase({ runId: 'RUN1', rid: 'run-fin', finalStatus: 'succeeded', post, session: s });
		expect(posts[0]).toEqual({
			action: 'finishConfirm',
			fields: { runId: 'RUN1', finalStatus: 'succeeded', tips: JSON.stringify({ nextTipIndex: 29, pickUpTipCount: 5 }), line: 'tailnet' }
		});
		await stopRunTwoPhase({ action: 'abort', runId: 'RUN1', rid: 'run-fin', readFilledWells: false, fields: { reason: 'jam' }, post, session: s });
		expect(posts[1]).toEqual({
			action: 'abortConfirm',
			fields: { reason: 'jam', runId: 'RUN1', stopWarning: '', filledWells: 'null', line: 'tailnet' }
		});
	});
});
