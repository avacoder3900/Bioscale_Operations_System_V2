/**
 * Camera controls route: body shape checks happen here, value/range checks
 * on the Pi. These tests pin the shape checks and the soft failure for a Pi
 * without the route. No DB, no server: permissions, the Pi client and the
 * audit log are mocked. Named server.test.ts so SvelteKit's router ignores it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requirePermission, pi, audit } = vi.hoisted(() => ({
	requirePermission: vi.fn(),
	pi: {
		getCameraControls: vi.fn(),
		setCameraControls: vi.fn(),
		resetCameraControls: vi.fn()
	},
	audit: { create: vi.fn() }
}));

vi.mock('$lib/server/permissions', () => ({ requirePermission }));
vi.mock('$lib/server/robot-arm-client', () => ({ robotArm: pi }));
vi.mock('$lib/server/db', () => ({ connectDB: vi.fn(), AuditLog: audit, generateId: () => 'id1' }));

import { GET, POST, parseControlsBody } from './+server';

const user = { _id: 'u1', username: 'alejandro' };
const ok = { available: true, reason: null, camera: 'external', device: '/dev/video4', source: 'v4l2-ctl', controls: [], saved: {}, saved_file: 'x' };

function post(body: unknown, name = 'external') {
	return POST({
		locals: { user },
		params: { name },
		request: new Request('http://bims/api/robot-arm/cameras/external/controls', { method: 'POST', body: JSON.stringify(body) })
	} as any);
}

beforeEach(() => {
	vi.clearAllMocks();
	pi.setCameraControls.mockResolvedValue({ ...ok, applied: ['gain'], rejected: {} });
	pi.resetCameraControls.mockResolvedValue({ ...ok, applied: ['gain'], rejected: {} });
	pi.getCameraControls.mockResolvedValue(ok);
	audit.create.mockResolvedValue(undefined);
});

describe('parseControlsBody', () => {
	it('keeps whole numbers, turns booleans into 0/1, defaults persist to true', () => {
		expect(parseControlsBody({ set: { gain: 10, white_balance_automatic: false, exposure_time_absolute: '80' } })).toEqual({
			set: { gain: 10, white_balance_automatic: 0, exposure_time_absolute: 80 },
			persist: true
		});
		expect(parseControlsBody({ set: { gain: 1 }, persist: false }).persist).toBe(false);
	});
	it('refuses what the Pi could not use: fractions, non-numbers, odd names, empty sets', () => {
		for (const body of [
			{ set: { gain: 1.5 } },
			{ set: { gain: 'bright' } },
			{ set: { 'Gain Level': 1 } },
			{ set: { 'gain;rm': 1 } },
			{ set: {} },
			{},
			null,
			{ set: [1, 2] }
		]) {
			expect(() => parseControlsBody(body), JSON.stringify(body)).toThrowError(expect.objectContaining({ status: 400 }));
		}
	});
	it('accepts reset without a set', () => {
		expect(parseControlsBody({ reset: true })).toEqual({ reset: true, persist: true });
	});
});

describe('POST', () => {
	it('needs manufacturing:write and forwards the set to the Pi, audit-logged', async () => {
		const res = await post({ set: { auto_exposure: 1, exposure_time_absolute: 80 } });
		expect(requirePermission).toHaveBeenCalledWith(user, 'manufacturing:write');
		expect(pi.setCameraControls).toHaveBeenCalledWith('external', { auto_exposure: 1, exposure_time_absolute: 80 }, true);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.installed).toBe(true);
		expect(body.applied).toEqual(['gain']);
		expect(audit.create).toHaveBeenCalledTimes(1);
		expect(audit.create.mock.calls[0][0]).toMatchObject({
			tableName: 'robot_arm_camera_controls',
			recordId: 'external',
			action: 'robot_arm.camera_controls.set',
			changedBy: 'alejandro'
		});
	});
	it('reset goes to the reset route', async () => {
		await post({ reset: true, persist: false });
		expect(pi.resetCameraControls).toHaveBeenCalledWith('external', false);
		expect(pi.setCameraControls).not.toHaveBeenCalled();
		expect(audit.create.mock.calls[0][0]).toMatchObject({ action: 'robot_arm.camera_controls.reset' });
	});
	it('a bad body is a 400 before the Pi is touched', async () => {
		await expect(post({ set: { gain: 2.5 } })).rejects.toMatchObject({ status: 400 });
		expect(pi.setCameraControls).not.toHaveBeenCalled();
	});
	it('a Pi without the route is installed:false, not an error', async () => {
		pi.setCameraControls.mockRejectedValue(new Error('robot-arm 404: Not Found'));
		const res = await post({ set: { gain: 1 } });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ installed: false, available: false });
	});
	it('any other Pi failure is a 502 without the upstream text', async () => {
		pi.setCameraControls.mockRejectedValue(new Error('fetch failed (route arm-pi.tailf65a70.ts.net returned 530)'));
		await expect(post({ set: { gain: 1 } })).rejects.toMatchObject({ status: 502, body: { message: 'Camera controls unavailable' } });
	});
	it('the audit log failing does not fail the write', async () => {
		audit.create.mockRejectedValue(new Error('mongo down'));
		const res = await post({ set: { gain: 1 } });
		expect(res.status).toBe(200);
	});
});

describe('GET', () => {
	it('reads with manufacturing:read and marks installed', async () => {
		const res = await GET({ locals: { user }, params: { name: 'external' } } as any);
		expect(requirePermission).toHaveBeenCalledWith(user, 'manufacturing:read');
		expect(await res.json()).toMatchObject({ installed: true, available: true, device: '/dev/video4' });
	});
	it('404 from the Pi → installed:false', async () => {
		pi.getCameraControls.mockRejectedValue(new Error('robot-arm 404: Not Found'));
		const res = await GET({ locals: { user }, params: { name: 'external' } } as any);
		expect(await res.json()).toMatchObject({ installed: false, available: false });
	});
});
