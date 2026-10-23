/**
 * Depth stream mode route: shape checks here, the switch itself on the Pi.
 * No DB, no server; permissions, Pi client and audit log are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requirePermission, pi, audit } = vi.hoisted(() => ({
	requirePermission: vi.fn(),
	pi: { getDepthConfig: vi.fn(), setDepthConfig: vi.fn() },
	audit: { create: vi.fn() }
}));

vi.mock('$lib/server/permissions', () => ({ requirePermission }));
vi.mock('$lib/server/robot-arm-client', () => ({ robotArm: pi }));
vi.mock('$lib/server/db', () => ({ connectDB: vi.fn(), AuditLog: audit, generateId: () => 'id1' }));

import { GET, POST, parseDepthConfigBody } from './+server';

const user = { _id: 'u1', username: 'alejandro' };
const cfg = {
	mode: '720p',
	width: 1280,
	height: 720,
	fps: 15,
	modes: { '480p': [848, 480], '720p': [1280, 720] },
	fps_choices: [6, 15, 30],
	persisted: true,
	file: 'calibrations/depth_config.json',
	status: { running: true, measured_fps: 14.9 },
	changed: true
};

function post(body: unknown) {
	return POST({ locals: { user }, request: new Request('http://bims/api/robot-arm/depth/config', { method: 'POST', body: JSON.stringify(body) }) } as any);
}

beforeEach(() => {
	vi.clearAllMocks();
	pi.setDepthConfig.mockResolvedValue(cfg);
	pi.getDepthConfig.mockResolvedValue({ ...cfg, changed: undefined });
	audit.create.mockResolvedValue(undefined);
});

describe('parseDepthConfigBody', () => {
	it('accepts the two modes and the three frame rates', () => {
		expect(parseDepthConfigBody({ mode: '720p' })).toEqual({ mode: '720p', persist: true });
		expect(parseDepthConfigBody({ fps: 30, persist: false })).toEqual({ fps: 30, persist: false });
		expect(parseDepthConfigBody({ mode: '480p', fps: '6' })).toEqual({ mode: '480p', fps: 6, persist: true });
	});
	it('refuses other sizes, other rates and an empty change', () => {
		for (const body of [{ mode: '1080p' }, { mode: 720 }, { fps: 20 }, { fps: 'fast' }, {}, null, { persist: true }]) {
			expect(() => parseDepthConfigBody(body), JSON.stringify(body)).toThrowError(expect.objectContaining({ status: 400 }));
		}
	});
});

describe('POST', () => {
	it('needs manufacturing:write, forwards to the Pi and audit-logs the mode', async () => {
		const res = await post({ mode: '720p' });
		expect(requirePermission).toHaveBeenCalledWith(user, 'manufacturing:write');
		expect(pi.setDepthConfig).toHaveBeenCalledWith({ mode: '720p', persist: true });
		expect(await res.json()).toMatchObject({ installed: true, mode: '720p', changed: true });
		expect(audit.create.mock.calls[0][0]).toMatchObject({
			tableName: 'robot_arm_depth',
			action: 'robot_arm.depth.config',
			newData: { mode: '720p', width: 1280, height: 720, changed: true },
			changedBy: 'alejandro'
		});
	});
	it('400 before the Pi on a bad body', async () => {
		await expect(post({ mode: '4k' })).rejects.toMatchObject({ status: 400 });
		expect(pi.setDepthConfig).not.toHaveBeenCalled();
	});
	it('Pi without the route → installed:false', async () => {
		pi.setDepthConfig.mockRejectedValue(new Error('robot-arm 404: Not Found'));
		expect(await (await post({ mode: '720p' })).json()).toMatchObject({ installed: false });
	});
	it('other Pi failures → 502 without upstream text', async () => {
		pi.setDepthConfig.mockRejectedValue(new Error('robot-arm 500: v4l2 exploded at http://100.103.204.105'));
		await expect(post({ mode: '720p' })).rejects.toMatchObject({ status: 502, body: { message: 'Depth config unavailable' } });
	});
});

describe('GET', () => {
	it('reads without starting anything and marks installed', async () => {
		const res = await GET({ locals: { user } } as any);
		expect(requirePermission).toHaveBeenCalledWith(user, 'manufacturing:read');
		expect(pi.getDepthConfig).toHaveBeenCalledTimes(1);
		expect(await res.json()).toMatchObject({ installed: true, mode: '720p' });
	});
});
