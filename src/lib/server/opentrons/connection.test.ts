/**
 * The two-key gate that decides a robot's line (OT2-TAILNET-4). The property
 * that matters most: a robot that nobody switched — B07, R04 today — can never
 * resolve to the tailnet, whatever the env says.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveRobotConnection, isValidDirectUrl } from './connection';

// The GET /connection route (bridgeJobs, OT2-TAILNET-5): robot + busy lookups mocked.
const robots: Record<string, any> = {};
let busyJob: any = null;
vi.mock('$lib/server/opentrons/proxy', () => ({ getRobot: async (id: string) => robots[id] ?? null }));
vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	Ot2BridgeCommand: { findOne: () => ({ sort: () => ({ lean: async () => busyJob }) }) }
}));
import { GET as connectionGET } from '../../../routes/api/opentrons-lab/robots/[id]/connection/+server';

const B14 = {
	_id: '8LufEAi5sYJ5JRk_fTfT7',
	name: 'Robot 1 B14',
	robotSerial: 'OT2CEP20200309B14',
	connection: { mode: 'tailnet', directUrl: 'https://ot2-b14.tailf65a70.ts.net' }
};
const B07 = { _id: '2vIu0fzsbqzkZ7_Zjj3h2', name: 'Robot 3 B07', robotSerial: 'OT2CEP20200217B07' };
const R04 = { _id: 'CCyX8FjTRGvYOd9vISGvi', name: 'Robot 2 R04', robotSerial: 'OT2CEP20210817R04' };

const saved = process.env.OT2_TAILNET_ROBOT_IDS;
afterEach(() => {
	if (saved === undefined) delete process.env.OT2_TAILNET_ROBOT_IDS;
	else process.env.OT2_TAILNET_ROBOT_IDS = saved;
});

describe('resolveRobotConnection', () => {
	it('env unset → queue for every robot, even a provisioned one', () => {
		delete process.env.OT2_TAILNET_ROBOT_IDS;
		expect(resolveRobotConnection(B14).transport).toBe('queue');
		expect(resolveRobotConnection(B14).reason).toContain('OT2_TAILNET_ROBOT_IDS');
	});

	it('env lists b14 + record says tailnet → tailnet with its URL', () => {
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14';
		expect(resolveRobotConnection(B14)).toMatchObject({ transport: 'tailnet', directUrl: 'https://ot2-b14.tailf65a70.ts.net' });
	});

	it('B07 / R04 stay on the queue even if the env names them (not provisioned)', () => {
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14,b07,r04';
		expect(resolveRobotConnection(B07).transport).toBe('queue');
		expect(resolveRobotConnection(R04).transport).toBe('queue');
	});

	it('provisioned robot NOT named in this deployment → queue', () => {
		process.env.OT2_TAILNET_ROBOT_IDS = 'r04';
		expect(resolveRobotConnection(B14).transport).toBe('queue');
	});

	it("mode 'queue' is the per-robot kill switch", () => {
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14';
		expect(resolveRobotConnection({ ...B14, connection: { ...B14.connection, mode: 'queue' } }).transport).toBe('queue');
	});

	it('a bad direct URL never goes direct', () => {
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14';
		for (const directUrl of ['http://ot2-b14.tailf65a70.ts.net', 'https://172.16.202.117', 'https://ot2-b14.evil.com', 'https://ot2-b14.tailf65a70.ts.net/runs']) {
			expect(resolveRobotConnection({ ...B14, connection: { mode: 'tailnet', directUrl } }).transport).toBe('queue');
		}
	});
});

describe('isValidDirectUrl', () => {
	it('accepts only https tailnet hosts with no port or path', () => {
		expect(isValidDirectUrl('https://ot2-b14.tailf65a70.ts.net')).toBe(true);
		expect(isValidDirectUrl('https://ot2-b14.tailf65a70.ts.net:443')).toBe(false);
		expect(isValidDirectUrl('https://ot2-b14.tail8a9291.ts.net')).toBe(false); // someone else's tailnet
		expect(isValidDirectUrl(undefined)).toBe(false);
	});
});

describe('GET /connection → bridgeJobs (daemon jobs over /bridge on this deployment)', () => {
	const MFG = { _id: 'u1', username: 'op', roles: [{ roleId: 'r', roleName: 'Mfg', permissions: ['manufacturing:read'] }] };
	const savedSecret = process.env.OT2_BRIDGE_TOKEN_SECRET;
	afterEach(() => {
		if (savedSecret === undefined) delete process.env.OT2_BRIDGE_TOKEN_SECRET;
		else process.env.OT2_BRIDGE_TOKEN_SECRET = savedSecret;
		busyJob = null;
	});
	const get = async (id: string) =>
		(await (connectionGET as any)({ params: { id }, locals: { user: MFG } })).json() as Promise<any>;

	it('tailnet robot + allowed here + secret set → bridgeJobs true', async () => {
		robots[B14._id] = B14;
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14';
		process.env.OT2_BRIDGE_TOKEN_SECRET = 'x'.repeat(40);
		expect(await get(B14._id)).toMatchObject({ transport: 'tailnet', bridgeJobs: true, busy: null });
	});

	it('tailnet robot but no secret on this deployment → bridgeJobs false (line still tailnet)', async () => {
		robots[B14._id] = B14;
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14';
		delete process.env.OT2_BRIDGE_TOKEN_SECRET;
		expect(await get(B14._id)).toMatchObject({ transport: 'tailnet', bridgeJobs: false });
	});

	it('B07 / R04 (queue line) → bridgeJobs false; the rest of the answer is unchanged', async () => {
		robots[B07._id] = B07;
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14,b07';
		process.env.OT2_BRIDGE_TOKEN_SECRET = 'x'.repeat(40);
		busyJob = { kind: 'sweep', createdAt: '2026-09-26T10:00:00.000Z', claimedAt: '2026-09-26T10:00:05.000Z' };
		const body = await get(B07._id);
		expect(body).toEqual({
			transport: 'queue',
			reason: 'queue — robot not switched to tailnet',
			hardened: false,
			busy: { kind: 'sweep', since: '2026-09-26T10:00:05.000Z' },
			bridgeJobs: false
		});
	});
});
