/**
 * The two-key gate that decides a robot's line (OT2-TAILNET-4). The property
 * that matters most: a robot that nobody switched — B07, R04 today — can never
 * resolve to the tailnet, whatever the env says.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveRobotConnection, isValidDirectUrl } from './connection';

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
