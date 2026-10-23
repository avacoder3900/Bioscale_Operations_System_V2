/**
 * Camera preset route + the pure input cleaner. The DB and the Pi client are
 * mocked; what is pinned here is the body dispatch, the permission split and
 * the 502-without-upstream-text rule for Pi failures.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requirePermission, lib } = vi.hoisted(() => ({
	requirePermission: vi.fn(),
	lib: { listPresets: vi.fn(), savePreset: vi.fn(), applyPreset: vi.fn(), archivePreset: vi.fn() }
}));
vi.mock('$lib/server/permissions', () => ({ requirePermission }));
vi.mock('$lib/server/robot-arm-camera-presets', async (importActual) => {
	const actual = await importActual<typeof import('$lib/server/robot-arm-camera-presets')>();
	return { ...lib, cleanPresetInput: actual.cleanPresetInput };
});
vi.mock('$lib/server/db', () => ({ connectDB: vi.fn(), AuditLog: { create: vi.fn() }, generateId: () => 'id1' }));
vi.mock('$lib/server/db/models', () => ({ RobotArmCameraPreset: {} }));
vi.mock('$lib/server/robot-arm-client', () => ({ robotArm: {} }));

import { GET, POST } from './+server';
import { cleanPresetInput } from '$lib/server/robot-arm-camera-presets';

const user = { _id: 'u1', username: 'alejandro' };
const preset = { _id: 'p1', name: 'Camera defaults — Shared Office, Blinds Open', values: { gain: 64 } };

function post(body: unknown) {
	return POST({ locals: { user }, params: { name: 'external' }, request: new Request('http://bims/x', { method: 'POST', body: JSON.stringify(body) }) } as any);
}

beforeEach(() => {
	vi.clearAllMocks();
	lib.listPresets.mockResolvedValue([preset]);
	lib.savePreset.mockResolvedValue(preset);
	lib.applyPreset.mockResolvedValue({ preset, result: { applied: ['gain'], rejected: {} } });
	lib.archivePreset.mockResolvedValue({ ...preset, archivedAt: 'now' });
});

describe('cleanPresetInput', () => {
	it('trims, caps and keeps whole-number values', () => {
		expect(cleanPresetInput({ name: '  Blinds open ', conditions: ' Shared office, blinds open ', values: { gain: 32, auto_exposure: 1 } })).toEqual({
			name: 'Blinds open',
			conditions: 'Shared office, blinds open',
			notes: null,
			kind: 'operator',
			values: { gain: 32, auto_exposure: 1 }
		});
		expect(cleanPresetInput({ name: 'd', kind: 'camera-default' }).values).toBeNull();
	});
	it('refuses an empty name, fractional values and bad control names', () => {
		expect(() => cleanPresetInput({ name: ' ' })).toThrow(/name/);
		expect(() => cleanPresetInput({ name: 'x', values: { gain: 1.5 } })).toThrow(/whole number/);
		expect(() => cleanPresetInput({ name: 'x', values: { 'Gain;': 1 } })).toThrow(/control name/);
		expect(() => cleanPresetInput({ name: 'x', values: {} })).toThrow(/empty/);
	});
});

describe('GET', () => {
	it('lists with manufacturing:read, archived only when asked', async () => {
		const res = await GET({ locals: { user }, params: { name: 'external' }, url: new URL('http://bims/x?archived=1') } as any);
		expect(requirePermission).toHaveBeenCalledWith(user, 'manufacturing:read');
		expect(lib.listPresets).toHaveBeenCalledWith('external', { includeArchived: true });
		expect(await res.json()).toEqual({ presets: [preset] });
	});
});

describe('POST', () => {
	it('save → savePreset with the user, needs manufacturing:write', async () => {
		const res = await post({ save: { name: 'n', conditions: 'c' } });
		expect(requirePermission).toHaveBeenCalledWith(user, 'manufacturing:write');
		expect(lib.savePreset).toHaveBeenCalledWith(user, 'external', { name: 'n', conditions: 'c' });
		expect(await res.json()).toEqual({ preset });
	});
	it('apply → applyPreset and returns the camera result', async () => {
		const res = await post({ apply: 'p1' });
		expect(lib.applyPreset).toHaveBeenCalledWith(user, 'external', 'p1');
		expect(await res.json()).toMatchObject({ result: { applied: ['gain'] } });
	});
	it('archive / restore', async () => {
		await post({ archive: 'p1' });
		expect(lib.archivePreset).toHaveBeenCalledWith(user, 'external', 'p1', true);
		await post({ restore: 'p1' });
		expect(lib.archivePreset).toHaveBeenCalledWith(user, 'external', 'p1', false);
	});
	it('validation errors are 400 with the message; Pi failures are 502 without it', async () => {
		lib.savePreset.mockRejectedValue(new Error('Give the preset a name.'));
		await expect(post({ save: { name: '' } })).rejects.toMatchObject({ status: 400, body: { message: 'Give the preset a name.' } });
		lib.applyPreset.mockRejectedValue(new Error('robot-arm 503: no frame at http://100.103.204.105'));
		await expect(post({ apply: 'p1' })).rejects.toMatchObject({ status: 502, body: { message: 'The arm camera could not be reached' } });
	});
	it('an unknown body is a 400', async () => {
		await expect(post({ hello: 1 })).rejects.toMatchObject({ status: 400 });
	});
});
