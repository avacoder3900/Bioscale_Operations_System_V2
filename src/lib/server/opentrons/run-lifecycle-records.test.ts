/**
 * The BIMS halves of the fill-page lifecycle (OT2-TAILNET-5 §7.1 / R2): the
 * confirms record robot observations, re-validate their shape, stamp the line,
 * and are idempotent — a finish is guarded by pipetteTipState.after, a repeated
 * cancel/abort confirm for a stopped run is a no-op, a repeated `played` is a
 * success. S8: the confirms move the OpentronsRunRecord to its terminal status.
 * Models are mocked; no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Doc = Record<string, any>;
const db = {
	wax: new Map<string, Doc>(),
	reagent: new Map<string, Doc>(),
	writes: [] as Array<{ model: string; op: string; args: any[] }>,
	audits: [] as Doc[],
	runRecords: [] as Doc[],
	updateMatched: 1
};

function chain(v: () => unknown) {
	const c: any = {
		select: () => c,
		sort: () => c,
		lean: async () => v(),
		catch: () => c,
		then: (res: any, rej: any) => Promise.resolve(v()).then(res, rej)
	};
	return c;
}
function modelMock(name: 'wax' | 'reagent') {
	const store = () => db[name];
	return {
		findById: (id: string) => chain(() => structuredClone(store().get(id) ?? null)),
		findOne: () => chain(() => null),
		updateOne: async (...args: any[]) => {
			db.writes.push({ model: name, op: 'updateOne', args });
			return { matchedCount: db.updateMatched, modifiedCount: db.updateMatched };
		},
		findByIdAndUpdate: (...args: any[]) => {
			db.writes.push({ model: name, op: 'findByIdAndUpdate', args });
			const id = args[0];
			const set = args[1]?.$set ?? {};
			const cur = store().get(id);
			if (cur) store().set(id, { ...cur, ...set });
			return chain(() => store().get(id) ?? null);
		}
	};
}

vi.mock('@sveltejs/kit', () => ({
	fail: (status: number, data: unknown) => ({ status, data, __fail: true }),
	redirect: (s: number, l: string) => {
		throw new Error(`redirect ${s} ${l}`);
	}
}));
vi.mock('$lib/server/permissions', () => ({ requirePermission: vi.fn() }));
vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'gen',
	AuditLog: { create: async (d: Doc) => db.audits.push(d) },
	WaxFillingRun: modelMock('wax'),
	ReagentBatchRecord: modelMock('reagent'),
	CartridgeRecord: {
		bulkWrite: async (ops: any[]) => {
			db.writes.push({ model: 'cart', op: 'bulkWrite', args: [ops] });
			return { modifiedCount: ops.length };
		},
		updateMany: async (...args: any[]) => db.writes.push({ model: 'cart', op: 'updateMany', args })
	},
	Equipment: { findByIdAndUpdate: () => ({ catch: () => {} }) },
	ManufacturingSettings: { findById: () => chain(() => null) },
	Ot2BridgeCommand: { create: async (d: Doc) => db.writes.push({ model: 'bridge', op: 'create', args: [d] }) },
	OpentronsRunRecord: {
		findOne: () => chain(() => null),
		create: async (d: Doc) => db.runRecords.push(d),
		updateOne: async (...args: any[]) => db.writes.push({ model: 'runRecord', op: 'updateOne', args })
	}
}));
vi.mock('./proxy', () => ({ getRobot: async (id: string) => ({ _id: id, name: 'Robot 1 B14', ip: 'x' }), bridgeDeviceIdForRobot: () => 'ot2-b14-bridge' }));
vi.mock('./transport', () => ({ serverTransport: () => ({}) }));
const runVerbMock = vi.hoisted(() => ({ fn: null as null | ((...a: any[]) => Promise<any>) }));
vi.mock('$lib/opentrons/ot2-protocol', async (importOriginal) => {
	const m: any = await importOriginal();
	return { ...m, runVerb: (...a: any[]) => (runVerbMock.fn ? runVerbMock.fn(...a) : m.runVerb(...a)) };
});
vi.mock('./calibration-rtps', () => ({ calibrationRtpValues: async () => ({}) }));
vi.mock('./protocol-freshness', () => ({}));
vi.mock('$lib/server/services/deck-calibration/run-guard', () => ({ resolveDeckBinding: async () => ({}), DeckBindingError: class {} }));
vi.mock('$lib/server/services/deck-calibration/rollout', () => ({ isHardenedRobot: () => false }));
vi.mock('$lib/server/services/inventory-transaction', () => ({ recordTransaction: vi.fn(async () => {}), resolvePartId: async () => 'part' }));
vi.mock('$lib/server/manufacturing/locked-cartridges', () => ({ protectLockedCarts: async (ids: string[]) => ({ safeIds: ids }) }));
vi.mock('$lib/server/services/cartridge-hard-delete', () => ({ hardDeleteUnfinalizedCartridges: vi.fn(async () => {}) }));
vi.mock('$lib/server/notifications', () => ({ notifyRunLifecycle: vi.fn(async () => {}) }));
vi.mock('$lib/manufacturing/reagent-run-estimate', () => ({ estimateReagentRunSeconds: () => ({ seconds: 600 }) }));

import {
	finishConfirm,
	stopConfirm,
	startConfirm,
	reconcileStartIntent,
	lifecycleActions,
	validStartObs,
	validTips,
	validFilledWells,
	validFinalStatus,
	validRunId,
	START_INTENT_CLEAR_MS
} from './run-lifecycle-records';

const USER = { _id: 'u1', username: 'alejandro' };

beforeEach(() => {
	db.wax.clear();
	db.reagent.clear();
	db.writes.length = 0;
	db.audits.length = 0;
	db.runRecords.length = 0;
	db.updateMatched = 1;
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

const formOf = (fields: Record<string, string>) => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return fd;
};
const ev = (fields: Record<string, string>) =>
	({ request: new Request('http://x/?/a', { method: 'POST', body: formOf(fields) }), locals: { user: USER } }) as any;

// ── validation of browser observations ─────────────────────────────────────

describe('observation validators', () => {
	it('run ids, statuses, tips, wells', () => {
		expect(validRunId('3f2a-11_b')).toBe(true);
		expect(validRunId('../../x')).toBe(false);
		expect(validFinalStatus('SUCCEEDED')).toBe('succeeded');
		expect(validFinalStatus('<script>')).toBeNull();
		expect(validTips({ nextTipIndex: 29, pickUpTipCount: 5 })).toEqual({ nextTipIndex: 29, pickUpTipCount: 5 });
		expect(validTips({ nextTipIndex: -1, pickUpTipCount: 5 })).toBeNull();
		expect(validTips({ nextTipIndex: null, pickUpTipCount: 1.5 })).toBeNull();
		expect(validFilledWells(['X2', 'A24'])).toEqual(['X2', 'A24']);
		expect(validFilledWells(null)).toBeNull();
		expect(validFilledWells(['X2', 'Z99'])).toBeUndefined();
		expect(validStartObs({ phase: 'played', opentronsRunId: 'r1' })).toEqual({ phase: 'played', opentronsRunId: 'r1' });
		expect(validStartObs({ phase: 'failed', stage: 'create', message: 'x', uncertain: true })).toEqual({ phase: 'failed', stage: 'create', message: 'x', uncertain: true });
		expect(validStartObs({ phase: 'failed', stage: 'nope', message: 'x' })).toBeNull();
		expect(validStartObs({ phase: 'created', opentronsRunId: 'r1' })).toBeNull();
	});
});

// ── finish ─────────────────────────────────────────────────────────────────

describe('finishConfirm', () => {
	const run = (over: Doc = {}) => ({
		_id: 'W1',
		opentronsRunId: 'ot-1',
		robot: { _id: 'rb', name: 'B14' },
		cartridgeIds: ['c1', 'c2'],
		pipetteTipState: { before: { nextTipIndex: 20, hostname: 'h' } },
		...over
	});

	it('records tips + audit (line stamped) + terminal run record; a clean wax run auto-advances', async () => {
		db.wax.set('W1', run());
		const r = await finishConfirm('wax', run(), { finalStatus: 'succeeded', tips: { nextTipIndex: 29, pickUpTipCount: 9 } }, USER, 'tailnet');
		expect(r).toEqual({ success: true, consumed: 9, nextTipIndex: 29, advanced: 2, autoCompleted: true });
		const guard = db.writes.find((w) => w.model === 'wax' && w.op === 'updateOne')!;
		expect(guard.args[0]).toEqual({ _id: 'W1', 'pipetteTipState.after.nextTipIndex': null });
		expect(db.audits[0].newData).toEqual({ opentronsRunFinalStatus: 'succeeded', pipetteTipAfter: 29, pipetteTipConsumed: 9, line: 'tailnet' });
		const rr = db.writes.find((w) => w.model === 'runRecord')!;
		expect(rr.args[0]).toMatchObject({ opentronsRunId: 'ot-1', manufacturingRunId: 'W1' });
		expect(rr.args[1].$set.status).toBe('succeeded');
	});

	it('the same math as before when the rack was refilled mid-run / no tracker comment', async () => {
		const r1 = await finishConfirm('reagent', run({ pipetteTipState: { before: { nextTipIndex: 90 }, rackRefilledDuringRun: true } }), { finalStatus: 'stopped', tips: { nextTipIndex: 4, pickUpTipCount: 10 } }, USER, 'queue');
		expect(r1).toMatchObject({ consumed: 10, nextTipIndex: 4, autoCompleted: false });
		const r2 = await finishConfirm('reagent', run(), { finalStatus: 'failed', tips: { nextTipIndex: null, pickUpTipCount: 3 } }, USER, 'queue');
		expect(r2).toMatchObject({ consumed: 3, nextTipIndex: 23 });
	});

	it('idempotent: a second confirm for a recorded run writes nothing more (R2)', async () => {
		db.updateMatched = 0;
		const r = await finishConfirm('wax', run(), { finalStatus: 'succeeded', tips: { nextTipIndex: 29, pickUpTipCount: 9 } }, USER, 'tailnet');
		expect(r).toEqual({ success: true, alreadyRecorded: true });
		expect(db.audits).toHaveLength(0);
		expect(db.writes.filter((w) => w.model === 'cart')).toHaveLength(0);
	});

	it('the action short-circuits a run whose tips are already recorded, and rejects a malformed observation', async () => {
		db.wax.set('W1', run({ pipetteTipState: { after: { nextTipIndex: 5 } } }));
		const { finishConfirm: act } = lifecycleActions('wax');
		expect(await act(ev({ runId: 'W1', finalStatus: 'succeeded', tips: '{"nextTipIndex":1,"pickUpTipCount":1}', line: 'tailnet' }))).toEqual({ success: true, alreadyRecorded: true });
		expect(await act(ev({ runId: 'W1', finalStatus: 'succeeded', tips: '{"nextTipIndex":"x"}' }))).toMatchObject({ status: 400, __fail: true });
		expect(db.writes).toHaveLength(0);
	});
});

// ── cancel / abort ─────────────────────────────────────────────────────────

describe('stop confirms', () => {
	const waxRun = { _id: 'W2', opentronsRunId: 'ot-2', robot: { _id: 'rb' }, cartridgeIds: ['c1', 'c2', 'c3'], protocolParameters: {}, status: 'Running' };
	const wellsFor = (cart: number) => {
		// cart 1 = X/W/V × cols 2,4,6,8; cart 2 = U/T/S
		const rows = cart === 1 ? 'XWV' : 'UTS';
		return [...rows].flatMap((r) => [2, 4, 6, 8].map((c) => `${r}${c}`));
	};

	it('wax smart abort: only the carts the robot proved filled advance; the rest revert', async () => {
		db.wax.set('W2', { ...waxRun });
		const r = await stopConfirm('wax', 'abort', 'W2', waxRun, { reason: 'jam' }, { stopWarning: null, filledWells: [...wellsFor(2)] }, USER, 'tailnet');
		expect(r).toEqual({ success: true, warning: undefined });
		const advance = db.writes.find((w) => w.model === 'cart' && w.op === 'bulkWrite')!;
		expect(advance.args[0].map((o: any) => o.updateOne.filter._id)).toEqual(['c2']);
		expect(db.writes.find((w) => w.model === 'cart' && w.op === 'updateMany')!.args[0]._id.$in).toEqual(['c1', 'c2', 'c3']);
		const runAudit = db.audits.find((a) => a.tableName === 'wax_filling_runs')!;
		expect(runAudit.newData).toEqual({ status: 'aborted', abortReason: 'jam', revertedToBacking: 3, line: 'tailnet' });
		expect(db.writes.find((w) => w.model === 'runRecord')!.args[1].$set.status).toBe('stopped');
	});

	it('wells unavailable (null) → every scanned cart reverts, the stop warning is passed through', async () => {
		const r = await stopConfirm('wax', 'cancel', 'W2', waxRun, {}, { stopWarning: 'check the device', filledWells: null }, USER, 'queue');
		expect(r).toEqual({ success: true, warning: 'check the device' });
		expect(db.writes.some((w) => w.model === 'cart' && w.op === 'bulkWrite')).toBe(false);
		expect(db.audits.find((a) => a.tableName === 'wax_filling_runs')!.newData.abortReason).toBe('Cancelled by operator');
	});

	it('de-duplicated by run + action: a retried confirm for an already-stopped run is a no-op (R2)', async () => {
		db.wax.set('W2', { ...waxRun, status: 'aborted' });
		const { cancelConfirm } = lifecycleActions('wax');
		const r = await cancelConfirm(ev({ runId: 'W2', reason: 'x', stopWarning: '', filledWells: 'null', line: 'tailnet' }));
		expect(r).toEqual({ success: true, alreadyRecorded: true });
		expect(db.writes).toHaveLength(0);
		expect(db.audits).toHaveLength(0);
	});

	it('reagent abort through the action: status, photo, cart cleanup, line', async () => {
		db.reagent.set('R1', { _id: 'R1', opentronsRunId: 'ot-3', robot: { _id: 'rb' }, status: 'Running' });
		const { abortConfirm } = lifecycleActions('reagent');
		const r = await abortConfirm(ev({ runId: 'R1', reason: 'spill', photoUrl: 'https://p/1.jpg', stopWarning: '', filledWells: 'null', line: 'tailnet' }));
		expect(r).toEqual({ success: true, warning: undefined });
		const set = db.writes.find((w) => w.model === 'reagent' && w.op === 'findByIdAndUpdate')!.args[1].$set;
		expect(set).toMatchObject({ status: 'Aborted', abortReason: 'spill', abortPhotoUrl: 'https://p/1.jpg' });
		expect(db.audits[0].newData).toEqual({ status: 'Aborted', abortReason: 'spill', line: 'tailnet' });
	});

	it('malformed wells are refused before anything is written', async () => {
		db.wax.set('W2', { ...waxRun });
		const { abortConfirm } = lifecycleActions('wax');
		expect(await abortConfirm(ev({ runId: 'W2', filledWells: '["Q99"]' }))).toMatchObject({ status: 400 });
		expect(db.writes).toHaveLength(0);
	});
});

// ── start ──────────────────────────────────────────────────────────────────

describe('startConfirm', () => {
	const intent = (over: Doc = {}) => ({
		token: 'tok',
		requestedAt: new Date(),
		requestedBy: USER,
		line: 'tailnet',
		createArgs: { protocolId: 'p1', runTimeParameterValues: { a: 1 }, protocolParameters: { a: 1 }, deckGeometry: null },
		...over
	});

	it('created → run record written once; played → Running, auto-resume enqueued, intent cleared, audit with line', async () => {
		db.wax.set('W3', { _id: 'W3', robot: { _id: 'rb', name: 'B14' }, startIntent: intent() });
		expect(await startConfirm('wax', 'W3', 'tok', { phase: 'created', opentronsRunId: 'ot-9', protocolId: 'p1' }, USER, 'tailnet')).toEqual({ success: true, opentronsRunId: 'ot-9' });
		expect(db.runRecords).toHaveLength(1);
		expect(db.runRecords[0]).toMatchObject({ opentronsRunId: 'ot-9', opentronsProtocolId: 'p1', runtimeParameters: { a: 1 }, status: 'created' });
		db.wax.set('W3', { ...db.wax.get('W3')!, startIntent: intent({ opentronsRunId: 'ot-9' }) });
		expect(await startConfirm('wax', 'W3', 'tok', { phase: 'played', opentronsRunId: 'ot-9' }, USER, 'tailnet')).toEqual({ success: true, opentronsRunId: 'ot-9' });
		const upd = db.writes.find((w) => w.model === 'wax' && w.op === 'findByIdAndUpdate')!;
		expect(upd.args[1].$set).toMatchObject({ status: 'Running', opentronsRunId: 'ot-9', protocolParameters: { a: 1 } });
		expect(upd.args[1].$unset).toEqual({ startIntent: '' });
		expect(db.writes.find((w) => w.model === 'bridge')!.args[0]).toMatchObject({ kind: 'auto_resume_run', payload: { runId: 'ot-9' } });
		expect(db.audits.at(-1)!.newData).toMatchObject({ status: 'Running', opentronsRunId: 'ot-9', line: 'tailnet' });
	});

	it('a repeated played for the run already Running is a success (the intent is gone)', async () => {
		db.wax.set('W3', { _id: 'W3', status: 'Running', opentronsRunId: 'ot-9', robot: { _id: 'rb' } });
		expect(await startConfirm('wax', 'W3', 'tok', { phase: 'played', opentronsRunId: 'ot-9' }, USER, 'tailnet')).toMatchObject({ alreadyRecorded: true });
		expect(db.writes).toHaveLength(0);
	});

	it('the robot run must be for the protocol BIMS prepared; a stale token is refused', async () => {
		db.wax.set('W3', { _id: 'W3', robot: { _id: 'rb' }, startIntent: intent() });
		expect(await startConfirm('wax', 'W3', 'tok', { phase: 'created', opentronsRunId: 'ot-9', protocolId: 'p-other' }, USER, 'tailnet')).toMatchObject({ fail: { status: 409 } });
		expect(await startConfirm('wax', 'W3', 'old', { phase: 'created', opentronsRunId: 'ot-9', protocolId: 'p1' }, USER, 'tailnet')).toMatchObject({ fail: { status: 409 } });
		expect(db.runRecords).toHaveLength(0);
	});

	it('a create whose answer was lost keeps the intent (uncertain) instead of clearing it', async () => {
		db.wax.set('W3', { _id: 'W3', robot: { _id: 'rb' }, startIntent: intent() });
		await startConfirm('wax', 'W3', 'tok', { phase: 'failed', stage: 'create', message: 'lost', uncertain: true }, USER, 'tailnet');
		const w = db.writes.find((x) => x.model === 'wax')!;
		expect(Object.keys(w.args[1].$set)).toEqual(['startIntent.uncertainAt']);
	});
});

describe('reconcileStartIntent (load)', () => {
	const runWith = (intent: Doc) => ({ _id: 'W4', robot: { _id: 'rb' }, startIntent: { token: 'tok', line: 'tailnet', createArgs: { protocolId: 'p1' }, ...intent } });

	it('never fails a young start whose robot run is created but not yet played', async () => {
		runVerbMock.fn = async () => ({
			status: 200,
			body: { runs: [{ id: 'ot-5', status: 'idle', protocolId: 'p1', createdAt: new Date().toISOString() }], current: { id: 'ot-5', status: 'idle', protocolId: 'p1', createdAt: new Date().toISOString() } }
		});
		const run = runWith({ requestedAt: new Date(), opentronsRunId: 'ot-5' });
		db.wax.set('W4', run);
		const r = await reconcileStartIntent('wax', run, USER);
		expect(r.banner).toBeNull();
		expect(db.audits).toHaveLength(0);
		expect(db.writes.some((w) => w.args?.[1]?.$unset)).toBe(false);
		runVerbMock.fn = null;
	});

	it('an old intent with no robot run is cleared with an audit row', async () => {
		runVerbMock.fn = async () => ({ status: 200, body: { runs: [], current: null } });
		const run = runWith({ requestedAt: new Date(Date.now() - START_INTENT_CLEAR_MS - 1000) });
		const r = await reconcileStartIntent('wax', run, USER);
		expect(r).toEqual({ changed: true, banner: null });
		expect(db.audits[0]).toMatchObject({ action: 'start_intent_cleared', tableName: 'wax_filling_runs' });
		runVerbMock.fn = null;
	});
});
