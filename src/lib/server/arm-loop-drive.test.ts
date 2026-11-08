import { describe, expect, it, vi } from 'vitest';

let loopDoc: any = null;
vi.mock('$env/dynamic/private', () => ({ env: { ROBOT_ARM_API_KEY: 'pi-key-123' } }));
vi.mock('$lib/server/db', () => ({
	connectDB: async () => undefined,
	ArmWaxFillRun: { findById: () => ({ select: () => ({ lean: async () => loopDoc }) }), updateOne: async () => undefined },
	ArmWaxFillSettings: { findById: () => ({ select: () => ({ lean: async () => ({ armPiDrives: false }) }) }) }
}));
vi.mock('./robot-arm-client', () => ({ robotArmFetchRaw: async () => ({ ok: true, status: 200, text: '{}', headers: new Headers() }) }));
vi.mock('./robot-arm-animation', () => ({ afterPlay: async () => ({}), playbackActive: async () => null }));
const getLoop = vi.fn(async () => ({ _id: 'L1', status: 'running' }));
vi.mock('./arm-wax-fill', () => {
	class ArmWaxFillError extends Error {
		status: number;
		constructor(m: string, s = 400) {
			super(m);
			this.status = s;
		}
	}
	const f = async () => ({});
	return { ArmWaxFillError, getLoop: (...a: unknown[]) => getLoop(...(a as [])), cycleAwaitParked: f, cycleDecide: f, cycleFail: f, cycleFailDone: f, cycleFailPrepare: f, cycleFillWait: f, cycleGrab: f, cycleGrabDone: f, cycleScanRead: f, cycleScanStart: f, cycleSkipAhead: f, cycleWithdraw: f, cycleWithdrawDone: f, failLoop: f, loopFinish: f };
});

const { runDriveStep, isArmPiKey, armPiDrives } = await import('./arm-loop-drive');

describe('arm Pi loop driver endpoint', () => {
	it("refuses a loop the browser drives", async () => {
		loopDoc = { _id: 'L1', driver: 'browser', startedBy: { _id: 'u', username: 'a' } };
		await expect(runDriveStep('L1', 'cycleGrab')).rejects.toThrow('driven by the Run tab');
	});
	it('refuses a step that is not a loop step', async () => {
		loopDoc = { _id: 'L1', driver: 'arm-pi' };
		await expect(runDriveStep('L1', 'haltLoop')).rejects.toThrow('Unknown drive step');
		await expect(runDriveStep('L1', 'saveSetup')).rejects.toThrow('Unknown drive step');
	});
	it('runs a step for an arm-Pi loop', async () => {
		loopDoc = { _id: 'L1', driver: 'arm-pi', startedBy: { _id: 'u', username: 'a' } };
		expect(await runDriveStep('L1', 'loopState')).toEqual({ loop: { _id: 'L1', status: 'running' } });
	});
	it("takes only the Pi's key", () => {
		expect(isArmPiKey(new Request('http://x', { headers: { 'x-api-key': 'pi-key-123' } }))).toBe(true);
		expect(isArmPiKey(new Request('http://x', { headers: { 'x-api-key': 'pi-key-124' } }))).toBe(false);
		expect(isArmPiKey(new Request('http://x'))).toBe(false);
	});
	it('is off unless Setup turns it on', async () => {
		expect(await armPiDrives()).toBe(false);
	});
});
