import { describe, expect, it, vi } from 'vitest';
import { BridgeError, type BridgeClient, type BridgeJob } from './bridge-client';
import {
	controlSweepOverBridge,
	deckScanOverBridge,
	followSweep,
	restartServerOverBridge,
	snapshotFromJob,
	startSweepOverBridge,
	submitAutoResume,
	submitPreparedJob,
	tipSwapOverBridge,
	validJobDescriptor,
	type FillJobDeps
} from './fill-bridge-jobs';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function job(over: Partial<BridgeJob> = {}): BridgeJob {
	return {
		jobId: 'job-abc123',
		kind: 'sweep',
		status: 'running',
		progress: { slotsDone: 0, currentSlotIndex: null, scans: [], slotErrors: [], log: [], final: null, updates: 0 },
		result: null,
		error: null,
		pauseRequested: false,
		cancelRequested: false,
		queuePosition: 0,
		createdAt: 0,
		startedAt: 0,
		finishedAt: null,
		requestedBy: null,
		...over
	};
}

/** A BridgeClient double: every method is a spy; unimplemented ones throw. */
function fakeBridge(over: Partial<BridgeClient> = {}): BridgeClient {
	const nope = (name: string) =>
		vi.fn(async () => {
			throw new Error(`unexpected ${name}`);
		});
	return {
		robotId: 'robot-1',
		token: nope('token') as any,
		invalidateToken: vi.fn(),
		submitJob: nope('submitJob') as any,
		submit: nope('submit') as any,
		getJob: nope('getJob') as any,
		pollJob: nope('pollJob') as any,
		control: nope('control') as any,
		testScan: nope('testScan') as any,
		health: nope('health') as any,
		probe: nope('probe') as any,
		...over
	};
}

/** A BIMS fetch double: records every call, answers from `route`. */
function bims(route: (url: string, body: any, init?: RequestInit) => Response | Promise<Response>) {
	const calls: Array<{ url: string; method: string; body: any }> = [];
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		calls.push({ url, method: init?.method ?? 'GET', body });
		return route(url, body, init);
	});
	const deps: FillJobDeps = { fetch, sleep: async () => {}, nowMs: () => 0 };
	return { calls, fetch, deps };
}

const accepted = { jobId: 'job-abc123', status: 'queued' as const, position: 0, duplicate: false };

describe('validJobDescriptor', () => {
	it('accepts exactly the kind asked for, with an id and an object payload', () => {
		const j = { jobId: 'job-abc123', kind: 'sweep', payload: { a: 1 } };
		expect(validJobDescriptor(j, 'sweep')).toEqual(j);
		expect(validJobDescriptor(j, 'deck_scan')).toBeNull();
		expect(validJobDescriptor({ ...j, jobId: 'x' }, 'sweep')).toBeNull();
		expect(validJobDescriptor({ ...j, jobId: 'a/b/../c' }, 'sweep')).toBeNull();
		expect(validJobDescriptor({ ...j, payload: [] }, 'sweep')).toBeNull();
		expect(validJobDescriptor(null, 'sweep')).toBeNull();
	});
});

describe('submitPreparedJob', () => {
	const j = { jobId: 'job-abc123', kind: 'sweep' as const, payload: {} };

	it('submits once and returns the acceptance', async () => {
		const b = fakeBridge({ submit: vi.fn(async () => ({ ...accepted, position: 2 })) });
		const r = await submitPreparedJob(b, j, 'sweep');
		expect(r).toEqual({ ok: true, jobId: 'job-abc123', position: 2, duplicate: false });
		expect(b.submit).toHaveBeenCalledTimes(1);
	});

	it('a refused submit is never retried: the prepared row is abandoned and the error returned', async () => {
		const b = fakeBridge({ submit: vi.fn(async () => { throw new BridgeError('scope', 'forbidden', 403); }) });
		const abandon = vi.fn(async () => {});
		const r = await submitPreparedJob(b, j, 'sweep', abandon);
		expect(r).toMatchObject({ ok: false, status: 403 });
		expect((r as any).error).toContain('scope');
		expect(b.submit).toHaveBeenCalledTimes(1);
		expect(b.getJob).not.toHaveBeenCalled();
		expect(abandon).toHaveBeenCalledTimes(1);
	});

	it('no answer: reads the job by the id it sent (a read, not a re-submit) before calling it failed', async () => {
		const b = fakeBridge({
			submit: vi.fn(async () => { throw new BridgeError('timeout', 'network'); }),
			getJob: vi.fn(async () => job({ queuePosition: 1 }))
		});
		const abandon = vi.fn(async () => {});
		const r = await submitPreparedJob(b, j, 'sweep', abandon);
		expect(r).toEqual({ ok: true, jobId: 'job-abc123', position: 1, duplicate: true });
		expect(b.submit).toHaveBeenCalledTimes(1);
		expect(abandon).not.toHaveBeenCalled();
	});

	it('no answer and the job is not there: abandoned; an abandon error is logged, never thrown', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const b = fakeBridge({
			submit: vi.fn(async () => { throw new BridgeError('down', 'network'); }),
			getJob: vi.fn(async () => { throw new BridgeError('down', 'network'); })
		});
		const r = await submitPreparedJob(b, j, 'sweep', async () => { throw new Error('BIMS 500'); });
		expect(r.ok).toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('startSweepOverBridge', () => {
	const prepared = {
		sweepRunId: 'SW1',
		slotsTotal: 12,
		line: 'tailnet',
		job: { jobId: 'job-abc123', kind: 'sweep', payload: { sweepRunId: 'SW1', positions: [] } }
	};

	it('prepares on BIMS with line tailnet, then submits the returned job', async () => {
		const { calls, deps } = bims(() => json(200, prepared));
		const b = fakeBridge({ submit: vi.fn(async () => accepted) });
		const r = await startSweepOverBridge(b, { robotId: 'rb', source: 'wax_filling', contextRef: 'W1', maxSlots: 12 }, {}, deps);
		expect(r).toEqual({ ok: true, sweepRunId: 'SW1', jobId: 'job-abc123', slotsTotal: 12 });
		expect(calls).toEqual([
			{ url: '/api/scanner/sweep', method: 'POST', body: { robotId: 'rb', source: 'wax_filling', contextRef: 'W1', maxSlots: 12, line: 'tailnet' } }
		]);
		expect(b.submit).toHaveBeenCalledWith(prepared.job);
	});

	it('a refused prepare surfaces the route message and submits nothing', async () => {
		const { deps } = bims(() => json(409, { message: 'Another sweep is already running' }));
		const b = fakeBridge();
		const r = await startSweepOverBridge(b, { robotId: 'rb', source: 'wax_filling' }, {}, deps);
		expect(r).toEqual({ ok: false, error: 'Another sweep is already running', status: 409 });
	});

	it('a prepare without a job (an old server) is an error, not a queue sweep', async () => {
		const { deps } = bims(() => json(200, { sweepRunId: 'SW1', slotsTotal: 12 }));
		const r = await startSweepOverBridge(fakeBridge(), { robotId: 'rb', source: 'wax_filling' }, {}, deps);
		expect(r.ok).toBe(false);
	});

	it('a failed submit abandons the prepared SweepRun with the job id', async () => {
		const { calls, deps } = bims((url) => (url === '/api/scanner/sweep' ? json(200, prepared) : json(200, {})));
		const b = fakeBridge({ submit: vi.fn(async () => { throw new BridgeError('bad token', 'unauthorized', 401); }) });
		const r = await startSweepOverBridge(b, { robotId: 'rb', source: 'reagent_filling' }, {}, deps);
		expect(r.ok).toBe(false);
		expect(b.submit).toHaveBeenCalledTimes(1);
		expect(calls[1]).toMatchObject({
			url: '/api/scanner/sweep/SW1',
			method: 'POST',
			body: { action: 'abandon', line: 'tailnet', jobId: 'job-abc123' }
		});
		expect(calls[1].body.error).toContain('bad token');
	});
});

describe('snapshotFromJob', () => {
	it('maps the daemon job onto the SweepRun snapshot shape', () => {
		const s = snapshotFromJob(
			job({
				progress: {
					slotsDone: 2,
					currentSlotIndex: 2,
					scans: [{ slotIndex: 0, barcode: 'C1', rawPayload: 'raw' }, { slotIndex: 1, barcode: 'C2' }, { junk: true }],
					slotErrors: [{ slotIndex: 3, message: 'no read' }],
					log: [{ ts: 1, level: 'bogus', message: 'hi' }],
					final: null,
					updates: 3
				},
				pauseRequested: true
			}),
			'SW1',
			5
		);
		expect(s).toMatchObject({
			_id: 'SW1',
			status: 'running',
			slotsTotal: 5,
			slotsDone: 2,
			currentSlotIndex: 2,
			errors: [{ slotIndex: 3, message: 'no read' }],
			pauseRequested: true,
			line: 'tailnet',
			bridgeJobId: 'job-abc123'
		});
		expect(s.scans.map((x) => x.barcode)).toEqual(['C1', 'C2']);
		expect(s.log).toEqual([{ ts: new Date(1000).toISOString(), level: 'info', message: 'hi' }]);
	});

	it('terminal states: final wins, then the job status', () => {
		const fin = (final: any, over: Partial<BridgeJob> = {}) =>
			snapshotFromJob(job({ ...over, progress: { ...job().progress, final } }), 'SW1', 1);
		expect(fin({ status: 'errored', abortReason: 'scanner down' })).toMatchObject({ status: 'errored', abortReason: 'scanner down' });
		expect(fin(null, { status: 'completed', result: { status: 'cancelled' } }).status).toBe('cancelled');
		expect(fin(null, { status: 'completed' }).status).toBe('completed');
		expect(fin(null, { status: 'failed', error: 'boom' })).toMatchObject({ status: 'errored', abortReason: 'boom' });
		expect(fin(null, { status: 'cancelled' }).status).toBe('cancelled');
		// A paused walk stays 'running', exactly as the SweepRun does.
		expect(fin(null, { pauseRequested: true }).status).toBe('running');
	});
});

describe('followSweep', () => {
	it('feeds /bridge snapshots until the handler says terminal', async () => {
		const seq = [job(), job({ progress: { ...job().progress, slotsDone: 1, final: { status: 'completed' } } })];
		const b = fakeBridge({ getJob: vi.fn(async () => seq.shift()!) });
		const seen: string[] = [];
		const { fetch, deps } = bims(() => json(500, {}));
		const r = await followSweep(
			{ bridge: b, sweepRunId: 'SW1', jobId: 'job-abc123', slotsTotal: 1, onSnapshot: (s) => (seen.push(s.status), s.status !== 'running') },
			deps
		);
		expect(r).toMatchObject({ ok: true, source: 'bridge', snapshot: { status: 'completed', slotsDone: 1 } });
		expect(seen).toEqual(['running', 'completed']);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('reattaches to the BIMS rows when the bridge stops answering', async () => {
		const b = fakeBridge({ getJob: vi.fn(async () => { throw new BridgeError('down', 'network'); }) });
		const { calls, deps } = bims(() => json(200, { _id: 'SW1', status: 'completed', slotsTotal: 1, slotsDone: 1, scans: [], errors: [], log: [] }));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const r = await followSweep(
			{ bridge: b, sweepRunId: 'SW1', jobId: 'job-abc123', slotsTotal: 1, maxMisses: 2, onSnapshot: (s) => s.status !== 'running' },
			deps
		);
		warn.mockRestore();
		expect(r).toMatchObject({ ok: true, source: 'bims', snapshot: { status: 'completed' } });
		expect(b.getJob).toHaveBeenCalledTimes(3);
		expect(calls).toEqual([{ url: '/api/scanner/sweep/SW1', method: 'GET', body: undefined }]);
	});

	it('a refused bridge read (e.g. 404 after a daemon restart) reattaches at once', async () => {
		const b = fakeBridge({ getJob: vi.fn(async () => { throw new BridgeError('gone', 'not_found', 404); }) });
		const { deps } = bims(() => json(200, { _id: 'SW1', status: 'errored', abortReason: 'x', scans: [], errors: [], log: [] }));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const r = await followSweep({ bridge: b, sweepRunId: 'SW1', jobId: 'job-abc123', slotsTotal: 1, onSnapshot: (s) => s.status !== 'running' }, deps);
		warn.mockRestore();
		expect(r).toMatchObject({ ok: true, source: 'bims' });
		expect(b.getJob).toHaveBeenCalledTimes(1);
	});

	it('after a cancel the BIMS row (terminal at once) is followed, not the still-stopping job', async () => {
		const b = fakeBridge({ getJob: vi.fn(async () => job({ cancelRequested: true })) });
		const { calls, deps } = bims(() => json(200, { _id: 'SW1', status: 'cancelled', scans: [], errors: [], log: [] }));
		const r = await followSweep({ bridge: b, sweepRunId: 'SW1', jobId: 'job-abc123', slotsTotal: 1, onSnapshot: (s) => s.status !== 'running' }, deps);
		expect(r).toMatchObject({ ok: true, source: 'bims', snapshot: { status: 'cancelled' } });
		expect(b.getJob).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(1);
	});

	it('times out with the last snapshot', async () => {
		let t = 0;
		const b = fakeBridge({ getJob: vi.fn(async () => job()) });
		const r = await followSweep(
			{ bridge: b, sweepRunId: 'SW1', jobId: 'job-abc123', slotsTotal: 1, timeoutMs: 1000, onSnapshot: () => false },
			{ sleep: async () => { t += 600; }, nowMs: () => t }
		);
		expect(r).toMatchObject({ ok: false, timedOut: true, snapshot: { status: 'running' } });
	});
});

describe('controlSweepOverBridge', () => {
	it('pause / cancel: the /bridge job first, then the SweepRun flag', async () => {
		const order: string[] = [];
		const b = fakeBridge({ control: vi.fn(async (_id, a) => (order.push(`bridge:${a}`), job())) });
		const { deps } = bims((url, body) => (order.push(`bims:${body.action}`), json(200, {})));
		expect(await controlSweepOverBridge(b, 'SW1', 'job-abc123', 'pause', deps)).toEqual({ ok: true });
		expect(await controlSweepOverBridge(b, 'SW1', 'job-abc123', 'cancel', deps)).toEqual({ ok: true });
		expect(order).toEqual(['bridge:pause', 'bims:pause', 'bridge:cancel', 'bims:cancel']);
	});

	it('resume: BIMS first (the daemon ORs its flag), then the bridge', async () => {
		const order: string[] = [];
		const b = fakeBridge({ control: vi.fn(async (_id, a) => (order.push(`bridge:${a}`), job())) });
		const { deps } = bims((url, body) => (order.push(`bims:${body.action}`), json(200, {})));
		expect(await controlSweepOverBridge(b, 'SW1', 'job-abc123', 'resume', deps)).toEqual({ ok: true });
		expect(order).toEqual(['bims:resume', 'bridge:resume']);
	});

	it('a 409 on either side means "already finished"; one side failing is enough to pause/cancel', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const conflict = fakeBridge({ control: vi.fn(async () => { throw new BridgeError('done', 'conflict', 409); }) });
		expect(await controlSweepOverBridge(conflict, 'SW1', 'job-abc123', 'cancel', bims(() => json(409, {})).deps)).toEqual({ ok: true });
		const down = fakeBridge({ control: vi.fn(async () => { throw new BridgeError('down', 'network'); }) });
		expect(await controlSweepOverBridge(down, 'SW1', 'job-abc123', 'cancel', bims(() => json(200, {})).deps)).toEqual({ ok: true });
		expect(await controlSweepOverBridge(down, 'SW1', 'job-abc123', 'cancel', bims(() => json(500, { message: 'db down' })).deps)).toEqual({
			ok: false,
			error: 'db down'
		});
		expect((await controlSweepOverBridge(down, 'SW1', 'job-abc123', 'resume', bims(() => json(200, {})).deps)).ok).toBe(false);
		warn.mockRestore();
	});
});

describe('deckScanOverBridge', () => {
	it('prepare → submit → poll → confirm with the job outcome', async () => {
		const { calls, deps } = bims((url, body) =>
			body.phase === 'confirm'
				? json(200, { success: true, barcode: 'DECK-004' })
				: json(200, { success: true, line: 'tailnet', job: { jobId: 'job-deck01', kind: 'deck_scan', payload: { position: {} } } })
		);
		const b = fakeBridge({
			submit: vi.fn(async () => ({ ...accepted, jobId: 'job-deck01' })),
			pollJob: vi.fn(async () => job({ jobId: 'job-deck01', kind: 'deck_scan', status: 'completed', result: { barcode: 'QR-9' } }))
		});
		const r = await deckScanOverBridge(b, 'rb', {}, deps);
		expect(r).toEqual({ ok: true, barcode: 'DECK-004' });
		expect(b.submit).toHaveBeenCalledTimes(1);
		expect(calls.map((c) => c.body)).toEqual([
			{ robotId: 'rb', line: 'tailnet' },
			{ robotId: 'rb', line: 'tailnet', phase: 'confirm', jobId: 'job-deck01', status: 'completed', result: { barcode: 'QR-9' }, error: null }
		]);
	});

	it('a failed scan is confirmed too (the server answers 502 with the reason)', async () => {
		const { deps } = bims((url, body) =>
			body.phase === 'confirm'
				? json(502, { message: 'no barcode (after 2 attempts)' })
				: json(200, { job: { jobId: 'job-deck01', kind: 'deck_scan', payload: {} } })
		);
		const b = fakeBridge({
			submit: vi.fn(async () => accepted),
			pollJob: vi.fn(async () => job({ kind: 'deck_scan', status: 'failed', error: 'no barcode (after 2 attempts)' }))
		});
		expect(await deckScanOverBridge(b, 'rb', {}, deps)).toEqual({ ok: false, error: 'no barcode (after 2 attempts)', status: 502 });
	});

	it('a failed submit returns the error and confirms nothing', async () => {
		const { calls, deps } = bims(() => json(200, { job: { jobId: 'job-deck01', kind: 'deck_scan', payload: {} } }));
		const b = fakeBridge({ submit: vi.fn(async () => { throw new BridgeError('disabled', 'disabled', 503); }) });
		const r = await deckScanOverBridge(b, 'rb', {}, deps);
		expect(r.ok).toBe(false);
		expect(calls).toHaveLength(1);
	});
});

describe('tipSwapOverBridge', () => {
	it('prepares through the page action with line tailnet and submits the job', async () => {
		const post = vi.fn(async () => ({
			ok: true as const,
			data: { success: true, job: { jobId: 'job-tip001', kind: 'tip_swap_request', payload: { mode: 'rack', cancel: false, runId: 'ot-1' } } }
		}));
		const b = fakeBridge({ submit: vi.fn(async () => accepted) });
		const r = await tipSwapOverBridge(b, post, { runId: 'W1', mode: 'rack', cancel: 'false' });
		expect(r).toEqual({ ok: true, jobId: 'job-tip001' });
		expect(post).toHaveBeenCalledWith('requestTipSwap', { runId: 'W1', mode: 'rack', cancel: 'false', line: 'tailnet' });
		expect(b.submit).toHaveBeenCalledTimes(1);
	});

	it('a failed submit posts phase abandon with the job id', async () => {
		const post = vi.fn(async (_a: string, f: Record<string, string>) =>
			f.phase === 'abandon'
				? { ok: true as const, data: { abandoned: true } }
				: { ok: true as const, data: { job: { jobId: 'job-tip001', kind: 'tip_swap_request', payload: {} } } }
		);
		const b = fakeBridge({ submit: vi.fn(async () => { throw new BridgeError('nope', 'forbidden', 403); }) });
		const r = await tipSwapOverBridge(b, post, { runId: 'W1', mode: 'hand', cancel: 'false' });
		expect(r.ok).toBe(false);
		expect(post).toHaveBeenLastCalledWith('requestTipSwap', expect.objectContaining({ runId: 'W1', line: 'tailnet', phase: 'abandon', bridgeJobId: 'job-tip001' }));
	});

	it('a refused prepare is returned as-is', async () => {
		const post = vi.fn(async () => ({ ok: false as const, status: 409, error: 'no secret' }));
		expect(await tipSwapOverBridge(fakeBridge(), post, { runId: 'W1', mode: 'rack', cancel: 'false' })).toEqual({ ok: false, error: 'no secret', status: 409 });
	});
});

describe('restartServerOverBridge', () => {
	it('prepares with line tailnet and submits; the message mentions a queued position', async () => {
		const { calls, deps } = bims(() => json(200, { job: { jobId: 'job-rst001', kind: 'restart_robot_server', payload: {} } }));
		const b = fakeBridge({ submit: vi.fn(async () => ({ ...accepted, position: 2 })) });
		const r = await restartServerOverBridge(b, 'rb 1', deps);
		expect(r.ok).toBe(true);
		expect((r as any).message).toContain('queued behind 2');
		expect(calls).toEqual([{ url: '/api/opentrons-lab/robots/rb%201/restart-server', method: 'POST', body: { line: 'tailnet' } }]);
	});

	it('a failed submit posts phase abandon', async () => {
		const { calls, deps } = bims(() => json(200, { job: { jobId: 'job-rst001', kind: 'restart_robot_server', payload: {} } }));
		const b = fakeBridge({ submit: vi.fn(async () => { throw new BridgeError('401', 'unauthorized', 401); }) });
		const r = await restartServerOverBridge(b, 'rb', deps);
		expect(r.ok).toBe(false);
		expect(calls[1].body).toMatchObject({ line: 'tailnet', phase: 'abandon', jobId: 'job-rst001' });
	});
});

describe('submitAutoResume', () => {
	it('submits a valid job once; a failure is logged, never thrown', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const b = fakeBridge({ submit: vi.fn(async () => { throw new BridgeError('down', 'network'); }) });
		await expect(submitAutoResume(b, { jobId: 'job-auto01', kind: 'auto_resume_run', payload: { runId: 'r' } })).resolves.toBeUndefined();
		expect(b.submit).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('ignores anything that is not an auto_resume_run job', async () => {
		const b = fakeBridge({ submit: vi.fn(async () => accepted) });
		await submitAutoResume(b, { jobId: 'job-auto01', kind: 'sweep', payload: {} });
		await submitAutoResume(b, undefined);
		expect(b.submit).not.toHaveBeenCalled();
	});
});
