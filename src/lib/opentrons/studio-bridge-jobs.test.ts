import { describe, expect, it, vi } from 'vitest';
import { BridgeError, type BridgeClient, type BridgeJob } from './bridge-client';
import {
	StudioJobError,
	calibrateTipOverBridge,
	describeJobProgress,
	testScanOverBridge
} from './studio-bridge-jobs';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function job(over: Partial<BridgeJob> = {}): BridgeJob {
	return {
		jobId: 'job-abc123',
		kind: 'calibrate_tip',
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
	const nope = (name: string) => vi.fn(async () => {
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

const CAL_REQUEST = {
	robotId: 'robot-1',
	deckLoadName: 'deck_x',
	mount: 'left',
	tipProfile: 'wax',
	tipWell: 'A1',
	runId: 'run-1',
	pipetteId: 'pip-1',
	calibrator: { x: 1, y: 2, z: 3 }
};

const PREPARED = {
	success: true,
	line: 'tailnet',
	job: { jobId: 'job-abc123', kind: 'calibrate_tip', payload: { pipetteMount: 'left' } },
	calibrator: { x: 1, y: 2, z: 3 },
	calibratorSource: 'jogged'
};

function bims(handler: (path: string, body: any) => Response) {
	const calls: Array<{ path: string; body: any }> = [];
	const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ path, body });
		return handler(path, body);
	});
	return { fetchFn, calls };
}

describe('calibrateTipOverBridge', () => {
	it('prepare → submit → poll → confirm, with the SAME request body both times', async () => {
		const probe = { success: true, adjust: { x: 0.1, y: -0.2 }, probed: { x: 1, y: 2, z: 3 } };
		const b = bims((_p, body) => json(200, body.phase === 'confirm' ? probe : PREPARED));
		const final = job({ status: 'completed', result: { adjust: { x: 0.1, y: -0.2 } } });
		const progress: string[] = [];
		const bridge = fakeBridge({
			submit: vi.fn(async () => ({ jobId: 'job-abc123', status: 'queued' as const, position: 0, duplicate: false })),
			pollJob: vi.fn(async (_id: string, onProgress?: (j: BridgeJob) => void) => {
				onProgress?.(job({ status: 'queued', queuePosition: 2 }));
				onProgress?.(job({ progress: { ...job().progress, log: [{ ts: 1, level: 'info', message: 'probing X' }] } }));
				return final;
			})
		});

		const out = await calibrateTipOverBridge(bridge, CAL_REQUEST, {
			bimsFetch: b.fetchFn,
			onProgress: (t) => progress.push(t)
		});

		expect(out).toEqual(probe);
		expect(b.calls).toHaveLength(2);
		expect(b.calls[0]).toEqual({ path: '/api/scanner/calibrate-tip', body: { ...CAL_REQUEST, line: 'tailnet', phase: 'prepare' } });
		expect(b.calls[1]).toEqual({
			path: '/api/scanner/calibrate-tip',
			body: {
				...CAL_REQUEST,
				line: 'tailnet',
				phase: 'confirm',
				jobId: 'job-abc123',
				status: 'completed',
				result: { adjust: { x: 0.1, y: -0.2 } },
				error: null
			}
		});
		expect(bridge.submit).toHaveBeenCalledTimes(1);
		expect(bridge.submit).toHaveBeenCalledWith(PREPARED.job);
		expect(progress).toEqual(['waiting for the robot (2 ahead)', 'probing X']);
	});

	it('a failed job is still recorded through the confirm (route answers noReading)', async () => {
		const b = bims((_p, body) =>
			json(200, body.phase === 'confirm' ? { success: false, error: 'limit switch not reached', probed: null } : PREPARED)
		);
		const bridge = fakeBridge({
			submit: vi.fn(async () => ({ jobId: 'job-abc123', status: 'queued' as const, position: 0, duplicate: false })),
			pollJob: vi.fn(async () => job({ status: 'failed', error: 'limit switch not reached' }))
		});
		const out = await calibrateTipOverBridge(bridge, CAL_REQUEST, { bimsFetch: b.fetchFn });
		expect(out.success).toBe(false);
		expect(b.calls[1].body).toMatchObject({ status: 'failed', error: 'limit switch not reached', result: null });
	});

	it('prepare refused (409) → throws at prepare, never touches the robot', async () => {
		const b = bims(() => json(409, { message: 'queue — robot not switched to tailnet' }));
		const bridge = fakeBridge();
		await expect(calibrateTipOverBridge(bridge, CAL_REQUEST, { bimsFetch: b.fetchFn })).rejects.toMatchObject({
			name: 'StudioJobError',
			stage: 'prepare',
			message: expect.stringContaining('robot not switched to tailnet')
		});
		expect(bridge.submit).not.toHaveBeenCalled();
		expect(b.calls).toHaveLength(1);
	});

	it('submit rejected by the daemon → no retry, no queue call, no confirm', async () => {
		const b = bims(() => json(200, PREPARED));
		const bridge = fakeBridge({
			submit: vi.fn(async () => {
				throw new BridgeError('token scope', 'forbidden', 403);
			})
		});
		const err = await calibrateTipOverBridge(bridge, CAL_REQUEST, { bimsFetch: b.fetchFn }).catch((e) => e);
		expect(err).toBeInstanceOf(StudioJobError);
		expect(err.stage).toBe('submit');
		expect(err.mayHaveRun).toBe(false);
		expect(bridge.submit).toHaveBeenCalledTimes(1);
		expect(bridge.getJob).not.toHaveBeenCalled();
		// Only the prepare reached BIMS: nothing on the queue, no confirm.
		expect(b.calls.map((c) => c.body.phase)).toEqual(['prepare']);
	});

	it('lost submit answer → ONE read of the jobId; if it landed, carries on (still no re-submit)', async () => {
		const b = bims((_p, body) => json(200, body.phase === 'confirm' ? { success: true, adjust: { x: 0, y: 0 } } : PREPARED));
		const bridge = fakeBridge({
			submit: vi.fn(async () => {
				throw new BridgeError('robot did not answer', 'network');
			}),
			getJob: vi.fn(async () => job({ status: 'running' })),
			pollJob: vi.fn(async () => job({ status: 'completed', result: { adjust: { x: 0, y: 0 } } }))
		});
		const out = await calibrateTipOverBridge(bridge, CAL_REQUEST, { bimsFetch: b.fetchFn });
		expect(out.success).toBe(true);
		expect(bridge.submit).toHaveBeenCalledTimes(1);
		expect(bridge.getJob).toHaveBeenCalledWith('job-abc123');
	});

	it('lost submit answer and the job is not visible → mayHaveRun error, no re-submit', async () => {
		const b = bims(() => json(200, PREPARED));
		const bridge = fakeBridge({
			submit: vi.fn(async () => {
				throw new BridgeError('robot did not answer', 'network');
			}),
			getJob: vi.fn(async () => {
				throw new BridgeError('robot did not answer', 'network');
			})
		});
		const err = await calibrateTipOverBridge(bridge, CAL_REQUEST, { bimsFetch: b.fetchFn }).catch((e) => e);
		expect(err).toMatchObject({ stage: 'submit', mayHaveRun: true });
		expect(err.message).toMatch(/NOT retried/);
		expect(bridge.submit).toHaveBeenCalledTimes(1);
		expect(b.calls).toHaveLength(1);
	});

	it('poll lost → confirm with status failed + a "may still finish" error (no reading taught)', async () => {
		const b = bims((_p, body) => json(200, body.phase === 'confirm' ? { success: false, error: body.error } : PREPARED));
		const bridge = fakeBridge({
			submit: vi.fn(async () => ({ jobId: 'job-abc123', status: 'queued' as const, position: 0, duplicate: false })),
			pollJob: vi.fn(async () => {
				throw new BridgeError('job not finished', 'timeout');
			})
		});
		const out = await calibrateTipOverBridge(bridge, CAL_REQUEST, { bimsFetch: b.fetchFn });
		expect(out.success).toBe(false);
		expect(b.calls[1].body).toMatchObject({ phase: 'confirm', status: 'failed', result: null });
		expect(b.calls[1].body.error).toMatch(/may still finish/);
	});

	it('record failure after a completed probe → record-stage error', async () => {
		const b = bims((_p, body) => (body.phase === 'confirm' ? json(500, { message: 'db down' }) : json(200, PREPARED)));
		const bridge = fakeBridge({
			submit: vi.fn(async () => ({ jobId: 'job-abc123', status: 'queued' as const, position: 0, duplicate: false })),
			pollJob: vi.fn(async () => job({ status: 'completed', result: {} }))
		});
		await expect(calibrateTipOverBridge(bridge, CAL_REQUEST, { bimsFetch: b.fetchFn })).rejects.toMatchObject({
			stage: 'record',
			message: expect.stringContaining('db down')
		});
	});

	it('a prepare without a calibrate_tip job is refused before the robot', async () => {
		const b = bims(() => json(200, { success: true, job: { kind: 'sweep', payload: {} } }));
		const bridge = fakeBridge();
		await expect(calibrateTipOverBridge(bridge, CAL_REQUEST, { bimsFetch: b.fetchFn })).rejects.toMatchObject({ stage: 'prepare' });
		expect(bridge.submit).not.toHaveBeenCalled();
	});
});

describe('testScanOverBridge', () => {
	const REQ = { deviceId: 'ot2-b14-scanner', robotId: 'robot-1', source: 'test', contextRef: 'teach:set1:3' };
	const PREP = { success: true, line: 'tailnet', job: { kind: 'scan', payload: { source: 'test', contextRef: 'teach:set1:3' } } };

	it('prepare → /bridge/scan → reads the daemon ScannerEvent back by bridgeScanId', async () => {
		const calls: string[] = [];
		const bimsFetch = vi.fn(async (path: string, init?: RequestInit) => {
			calls.push(path);
			if (path === '/api/scanner/trigger') {
				expect(JSON.parse(String(init?.body))).toEqual({ ...REQ, line: 'tailnet' });
				return json(200, PREP);
			}
			expect(path).toBe('/api/scanner/events?deviceId=ot2-b14-scanner&limit=20');
			return json(200, {
				events: [
					{ _id: 'e2', metadata: { triggerId: 't1' }, receivedAt: '2026-09-26T00:00:00.000Z' },
					{ _id: 'e1', metadata: { bridgeScanId: 'scan_1' }, receivedAt: '2026-09-26T00:00:01.000Z', barcode: 'ABC' }
				]
			});
		});
		const bridge = fakeBridge({
			testScan: vi.fn(async () => ({ scanId: 'scan_1', barcode: 'ABC', rawPayload: 'ABC\r', error: null, eventPosted: true }))
		});
		const out = await testScanOverBridge(bridge, REQ, { bimsFetch, sleep: async () => {} });
		expect(bridge.testScan).toHaveBeenCalledTimes(1);
		expect(bridge.testScan).toHaveBeenCalledWith(PREP.job.payload);
		expect(out).toMatchObject({ scanId: 'scan_1', barcode: 'ABC', error: null, receivedAt: '2026-09-26T00:00:01.000Z', eventPosted: true });
		expect(out.event?._id).toBe('e1');
		expect(calls).toEqual(['/api/scanner/trigger', '/api/scanner/events?deviceId=ot2-b14-scanner&limit=20']);
	});

	it('event not posted → uses the scan result + browser clock, no events lookup', async () => {
		const bimsFetch = vi.fn(async () => json(200, PREP));
		const bridge = fakeBridge({
			testScan: vi.fn(async () => ({ scanId: 'scan_2', barcode: null, rawPayload: null, error: 'no read', eventPosted: false }))
		});
		const out = await testScanOverBridge(bridge, REQ, { bimsFetch, nowIso: () => 'NOW' });
		expect(out).toMatchObject({ barcode: null, error: 'no read', receivedAt: 'NOW', event: null });
		expect(bimsFetch).toHaveBeenCalledTimes(1);
	});

	it('gives up looking for the event after N tries (the result still stands)', async () => {
		const bimsFetch = vi.fn(async (path: string) =>
			path === '/api/scanner/trigger' ? json(200, PREP) : json(200, { events: [] })
		);
		const bridge = fakeBridge({
			testScan: vi.fn(async () => ({ scanId: 'scan_3', barcode: 'X', rawPayload: 'X', error: null, eventPosted: true }))
		});
		const out = await testScanOverBridge(bridge, REQ, { bimsFetch, eventLookups: 3, sleep: async () => {}, nowIso: () => 'NOW' });
		expect(out).toMatchObject({ barcode: 'X', receivedAt: 'NOW', event: null });
		expect(bimsFetch).toHaveBeenCalledTimes(4);
	});

	it('scan fails on the robot → submit-stage error, never retried, no queue trigger', async () => {
		const bimsFetch = vi.fn(async () => json(200, PREP));
		const bridge = fakeBridge({
			testScan: vi.fn(async () => {
				throw new BridgeError('robot did not answer', 'network');
			})
		});
		const err = await testScanOverBridge(bridge, REQ, { bimsFetch }).catch((e) => e);
		expect(err).toMatchObject({ name: 'StudioJobError', stage: 'submit', mayHaveRun: true });
		expect(bridge.testScan).toHaveBeenCalledTimes(1);
		expect(bimsFetch).toHaveBeenCalledTimes(1); // the prepare only — no ScannerTrigger fallback
	});

	it('prepare refused → prepare-stage error, scanner untouched', async () => {
		const bimsFetch = vi.fn(async () => json(409, { message: 'OT2_BRIDGE_TOKEN_SECRET is not set' }));
		const bridge = fakeBridge();
		await expect(testScanOverBridge(bridge, REQ, { bimsFetch })).rejects.toMatchObject({
			stage: 'prepare',
			message: expect.stringContaining('OT2_BRIDGE_TOKEN_SECRET')
		});
		expect(bridge.testScan).not.toHaveBeenCalled();
	});
});

describe('describeJobProgress', () => {
	it('queued / running / terminal', () => {
		expect(describeJobProgress(job({ status: 'queued', queuePosition: 0 }))).toBe('queued on the robot');
		expect(describeJobProgress(job({ status: 'running' }))).toBe('running on the robot…');
		expect(
			describeJobProgress(job({ status: 'failed', progress: { ...job().progress, log: [{ ts: 1, level: 'error', message: 'boom' }] } }))
		).toBe('failed: boom');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The two BIMS routes this helper drives, exercised on BOTH lines with Mongo,
// the robot lookup and the labware resolver faked. The queue branch is pinned
// here so a tailnet change that leaks into it fails a test.
// ─────────────────────────────────────────────────────────────────────────────

const routeDb = vi.hoisted(() => ({
	commands: [] as any[],
	audits: [] as any[],
	triggers: [] as any[],
	existingAudit: null as any,
	robots: [] as any[],
	gate: { ok: true, directUrl: 'https://ot2-b14.tailf65a70.ts.net' } as { ok: boolean; directUrl?: string; reason?: string }
}));

vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'nanoid_job1',
	OpentronsRobot: {
		findOne: () => ({ lean: async () => null }),
		find: () => ({ select: () => ({ lean: async () => routeDb.robots }) })
	},
	Ot2BridgeCommand: {
		create: async (doc: any) => {
			routeDb.commands.push(doc);
			return doc;
		},
		findById: () => ({
			select: () => ({ lean: async () => ({ status: 'completed', result: { body: { adjust: { x: 0.5, y: -0.25 } } } }) })
		}),
		updateOne: async () => ({})
	},
	AuditLog: {
		create: async (doc: any) => {
			routeDb.audits.push(doc);
			return doc;
		},
		findOne: () => ({ select: () => ({ lean: async () => routeDb.existingAudit }) })
	},
	ScannerTrigger: {
		create: async (doc: any) => {
			routeDb.triggers.push(doc);
			return { _id: 'trig_1', ...doc };
		},
		countDocuments: async () => 0
	},
	ScannerEvent: {
		find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
		findOne: () => ({ sort: () => ({ lean: async () => null }) }),
		distinct: async () => []
	},
	TipCalibratorFixture: {},
	LabwareDefinition: {}
}));
vi.mock('$lib/server/permissions', () => ({ requirePermission: vi.fn() }));
vi.mock('$lib/server/opentrons/proxy', () => ({
	getRobot: async (id: string) => (id === 'b14' ? { _id: 'b14', name: 'OT-2 B14' } : null),
	// Same rule as proxy.ts: bridgeDeviceId, else ot2-<slot>-bridge from the name.
	bridgeDeviceIdForRobot: (r: { name?: string; bridgeDeviceId?: string }) => {
		if (r.bridgeDeviceId) return r.bridgeDeviceId;
		const slot = (r.name ?? '').match(/\b([A-Z]\d{2})\b/)?.[1]?.toLowerCase();
		return slot ? `ot2-${slot}-bridge` : 'unknown-bridge';
	}
}));
vi.mock('$lib/server/opentrons/bridge-token', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/opentrons/bridge-token')>()),
	bridgeJobGate: () => routeDb.gate
}));
vi.mock('$lib/server/services/deck-calibration/resolve', () => ({
	resolveLabwareDefinition: async () => ({ doc: { definition: { rack: true }, namespace: 'opentrons', version: 1 } })
}));
vi.mock('$lib/server/services/deck-calibration/tip-calibrator', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/services/deck-calibration/tip-calibrator')>()),
	resolveCalibratorPoint: async () => ({ point: { x: 125, y: 173, z: 34 }, source: 'fixture' })
}));

import { POST as calibrateTipPOST } from '../../routes/api/scanner/calibrate-tip/+server';
import { POST as triggerPOST } from '../../routes/api/scanner/trigger/+server';
import { load as scannerTestLoad } from '../../routes/manufacturing/cart-mfg/opentron-control/scanner-test/+page.server';

const USER = { _id: 'u1', username: 'alex' };
async function callRoute(handler: any, path: string, body: unknown): Promise<{ status: number; body: any }> {
	try {
		const res: Response = await handler({
			request: new Request(`http://bims.test${path}`, { method: 'POST', body: JSON.stringify(body) }),
			locals: { user: USER },
			url: new URL(`http://bims.test${path}`)
		});
		return { status: res.status, body: await res.json() };
	} catch (e: any) {
		if (typeof e?.status === 'number') return { status: e.status, body: e.body };
		throw e;
	}
}
function resetRouteDb() {
	routeDb.commands.length = 0;
	routeDb.audits.length = 0;
	routeDb.triggers.length = 0;
	routeDb.existingAudit = null;
	routeDb.gate = { ok: true, directUrl: 'https://ot2-b14.tailf65a70.ts.net' };
}

const ROUTE_CAL = {
	robotId: 'b14',
	mount: 'left',
	tipProfile: 'wax',
	tipWell: 'A1',
	runId: 'run-1',
	pipetteId: 'pip-1',
	calibrator: { x: 126, y: 174, z: 35 }
};

describe('POST /api/scanner/calibrate-tip', () => {
	it('queue line (no line flag): one Ot2BridgeCommand + an ot2_bridge_commands AuditLog, exactly as before', async () => {
		resetRouteDb();
		const r = await callRoute(calibrateTipPOST, '/api/scanner/calibrate-tip', ROUTE_CAL);
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ success: true, adjust: { x: 0.5, y: -0.25 }, calibratorSource: 'jogged' });
		expect(routeDb.commands).toHaveLength(1);
		expect(routeDb.commands[0]).toMatchObject({ kind: 'calibrate_tip', robotId: 'b14', deviceId: 'ot2-b14-bridge', requestedBy: 'alex' });
		expect(routeDb.audits).toHaveLength(1);
		expect(routeDb.audits[0]).toMatchObject({ tableName: 'ot2_bridge_commands', action: 'calibrate_tip' });
		expect(routeDb.audits[0].newData.line).toBeUndefined();
	});

	it('tailnet prepare: returns the job, writes nothing', async () => {
		resetRouteDb();
		const r = await callRoute(calibrateTipPOST, '/api/scanner/calibrate-tip', { ...ROUTE_CAL, line: 'tailnet', phase: 'prepare' });
		expect(r.status).toBe(200);
		expect(r.body.job).toMatchObject({ jobId: 'nanoid_job1', kind: 'calibrate_tip' });
		expect(r.body.job.payload).toMatchObject({
			pipetteMount: 'left',
			profile: 'wax',
			runId: 'run-1',
			pipetteId: 'pip-1',
			calibrator: { x: 126, y: 174, z: 35 }
		});
		expect(routeDb.commands).toHaveLength(0);
		expect(routeDb.audits).toHaveLength(0);
	});

	it('tailnet prepare refused by the gate → 409, nothing written', async () => {
		resetRouteDb();
		routeDb.gate = { ok: false, reason: 'OT2_BRIDGE_TOKEN_SECRET is not set on this deployment' };
		const r = await callRoute(calibrateTipPOST, '/api/scanner/calibrate-tip', { ...ROUTE_CAL, line: 'tailnet' });
		expect(r.status).toBe(409);
		expect(routeDb.commands).toHaveLength(0);
	});

	it('tailnet confirm (completed): the same completion half, AuditLog stamped line tailnet', async () => {
		resetRouteDb();
		const r = await callRoute(calibrateTipPOST, '/api/scanner/calibrate-tip', {
			...ROUTE_CAL,
			line: 'tailnet',
			phase: 'confirm',
			jobId: 'nanoid_job1',
			status: 'completed',
			result: { adjust: { x: 0.5, y: -0.25 } }
		});
		expect(r.body).toMatchObject({ success: true, adjust: { x: 0.5, y: -0.25 }, probedSource: 'derived-from-adjust' });
		expect(routeDb.commands).toHaveLength(0);
		expect(routeDb.audits).toHaveLength(1);
		expect(routeDb.audits[0]).toMatchObject({
			tableName: 'ot2_bridge_jobs',
			recordId: 'nanoid_job1',
			action: 'calibrate_tip',
			changedBy: 'alex'
		});
		expect(routeDb.audits[0].newData).toMatchObject({ line: 'tailnet', bridgeJobId: 'nanoid_job1', robotId: 'b14' });
	});

	it('tailnet confirm (failed): noReading, no AuditLog', async () => {
		resetRouteDb();
		const r = await callRoute(calibrateTipPOST, '/api/scanner/calibrate-tip', {
			...ROUTE_CAL,
			line: 'tailnet',
			phase: 'confirm',
			jobId: 'nanoid_job1',
			status: 'failed',
			error: 'limit switch not reached'
		});
		expect(r.body).toMatchObject({ success: false, error: 'limit switch not reached', probed: null, adjust: null });
		expect(routeDb.audits).toHaveLength(0);
	});

	it('tailnet confirm is idempotent per jobId: a repeat returns the recorded reading, no second AuditLog', async () => {
		resetRouteDb();
		routeDb.existingAudit = {
			newData: {
				probed: { x: 1, y: 2, z: 3 },
				probedSource: 'bridge',
				adjust: { x: 0.1, y: 0.2 },
				calibrator: { x: 126, y: 174, z: 35 },
				calibratorSource: 'jogged'
			}
		};
		const r = await callRoute(calibrateTipPOST, '/api/scanner/calibrate-tip', {
			...ROUTE_CAL,
			line: 'tailnet',
			phase: 'confirm',
			jobId: 'nanoid_job1',
			status: 'completed',
			result: { adjust: { x: 9, y: 9 } }
		});
		expect(r.body).toMatchObject({ success: true, duplicate: true, adjust: { x: 0.1, y: 0.2 } });
		expect(routeDb.audits).toHaveLength(0);
	});

	it('tailnet confirm without a valid jobId → 400', async () => {
		resetRouteDb();
		const r = await callRoute(calibrateTipPOST, '/api/scanner/calibrate-tip', {
			...ROUTE_CAL,
			line: 'tailnet',
			phase: 'confirm',
			status: 'completed'
		});
		expect(r.status).toBe(400);
	});
});

describe('POST /api/scanner/trigger', () => {
	it('queue line: one ScannerTrigger, answered with its id (unchanged)', async () => {
		resetRouteDb();
		const r = await callRoute(triggerPOST, '/api/scanner/trigger', { deviceId: 'ot2-b14-scanner', source: 'test', contextRef: 'teach:s:1' });
		expect(r).toEqual({ status: 200, body: { success: true, triggerId: 'trig_1' } });
		expect(routeDb.triggers).toHaveLength(1);
		expect(routeDb.triggers[0]).toMatchObject({
			deviceId: 'ot2-b14-scanner',
			source: 'test',
			contextRef: 'teach:s:1',
			requestedBy: 'u1',
			requestedByUsername: 'alex'
		});
	});

	it('tailnet: returns the scan job, writes no ScannerTrigger', async () => {
		resetRouteDb();
		const r = await callRoute(triggerPOST, '/api/scanner/trigger', {
			deviceId: 'ot2-b14-scanner',
			robotId: 'b14',
			source: 'test',
			contextRef: 'teach:s:1',
			line: 'tailnet'
		});
		expect(r.body).toEqual({
			success: true,
			line: 'tailnet',
			job: { kind: 'scan', payload: { source: 'test', contextRef: 'teach:s:1' } }
		});
		expect(routeDb.triggers).toHaveLength(0);
	});

	it('tailnet gate refused → 409, no ScannerTrigger', async () => {
		resetRouteDb();
		routeDb.gate = { ok: false, reason: 'queue — robot not switched to tailnet' };
		const r = await callRoute(triggerPOST, '/api/scanner/trigger', { deviceId: 'ot2-b14-scanner', robotId: 'b14', line: 'tailnet' });
		expect(r.status).toBe(409);
		expect(routeDb.triggers).toHaveLength(0);
	});
});

describe('scanner-test load: which OT-2 owns the scanner (robotId for openRobotSession)', () => {
	const load = (deviceId: string) =>
		scannerTestLoad({
			locals: { user: USER },
			url: new URL(`http://bims.test/manufacturing/cart-mfg/opentron-control/scanner-test?deviceId=${deviceId}`)
		} as any) as Promise<any>;

	it('maps ot2-<slot>-scanner to the robot by its daemon id', async () => {
		routeDb.robots = [
			{ _id: 'r_b07', name: 'Robot 3 B07' },
			{ _id: 'r_b14', name: 'OT-2 B14' }
		];
		expect((await load('ot2-b14-scanner')).scannerRobot).toEqual({ robotId: 'r_b14', name: 'OT-2 B14' });
	});

	it("the daemon-derived id wins over another robot's name-only form", async () => {
		// r_cfg's daemon reports as ot2-lab2-scanner; its name still yields
		// ot2-b14-scanner as a secondary form. r_plain's daemon IS ot2-b14-scanner.
		routeDb.robots = [
			{ _id: 'r_cfg', name: 'Robot B14', bridgeDeviceId: 'ot2-lab2-bridge' },
			{ _id: 'r_plain', name: 'Spare B14' }
		];
		expect((await load('ot2-b14-scanner')).scannerRobot?.robotId).toBe('r_plain');
		expect((await load('ot2-lab2-scanner')).scannerRobot?.robotId).toBe('r_cfg');
	});

	it('ambiguous or unknown scanner → no robot (queue trigger only)', async () => {
		routeDb.robots = [
			{ _id: 'r1', name: 'Robot B14' },
			{ _id: 'r2', name: 'Spare B14' }
		];
		expect((await load('ot2-b14-scanner')).scannerRobot).toBeNull();
		expect((await load('lab-mac-scanner-1')).scannerRobot).toBeNull();
	});
});
