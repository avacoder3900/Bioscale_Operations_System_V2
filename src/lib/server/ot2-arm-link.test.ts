import { beforeEach, describe, expect, it, vi } from 'vitest';

const raw = vi.fn();
vi.mock('./robot-arm-client', () => ({ robotArmFetchRaw: (...a: unknown[]) => raw(...a) }));
vi.mock('./db/connection', () => ({ connectDB: async () => undefined }));
vi.mock('./db/models', () => ({
	ArmWaxFillSettings: { findById: () => ({ select: () => ({ lean: async () => ({ useArmLink: true }) }) }) },
	RobotArmMove: { create: async () => undefined }
}));
const queue = vi.fn(async () => new Response('{"queue":true}', { status: 200 }));
vi.mock('./opentrons/proxy', () => ({ robotGet: queue, robotPost: queue, robotDelete: queue }));

const { ot2ViaArm, armLinkStatus } = await import('./ot2-arm-link');

const link = { active: 'cable', cable: { addr: 'x', up: true, rtt_ms: 2, error: null }, lan: { addr: null, up: false, rtt_ms: null, error: null }, robot: { name: 'OT2CEP20200217B07', serial: null }, self: { cable: '169.254.42.1', lan: null }, port: 31950 };
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, ok: status < 400, headers: new Headers(headers), text: JSON.stringify(body) });
const robot = { _id: 'r1', name: 'Robot 3 B07' };

describe('ot2ViaArm', () => {
	beforeEach(async () => {
		raw.mockReset();
		queue.mockClear();
		raw.mockResolvedValueOnce(res(200, link));
		await armLinkStatus({ fresh: true });
	});

	it('caps timeout_s at the 60 the Pi accepts (Home Gantry asks for 80)', async () => {
		raw.mockResolvedValueOnce(res(200, { ok: true }, { 'x-ot2-link': 'cable', 'x-ot2-ms': '20' }));
		const r = await ot2ViaArm(robot, 'POST', '/robot/home', { target: 'robot' }, { timeoutMs: 80_000 });
		expect(r?.status).toBe(200);
		expect(String(raw.mock.calls[1][0])).toBe('/ot2/api/robot/home?timeout_s=60');
		expect(queue).not.toHaveBeenCalled();
	});

	it('returns null (the caller then uses the queue) when the Pi itself refuses (no link header)', async () => {
		raw.mockResolvedValueOnce(res(422, { detail: 'bad' }));
		expect(await ot2ViaArm(robot, 'POST', '/robot/home', { target: 'robot' })).toBeNull();
	});

	it('sends a multipart body as-is with its content type', async () => {
		raw.mockResolvedValueOnce(res(201, { data: { id: 'p1' } }, { 'x-ot2-link': 'cable', 'x-ot2-ms': '900' }));
		const bytes = new Uint8Array([1, 2, 3]);
		const r = await ot2ViaArm(robot, 'POST', '/protocols', undefined, { rawBody: bytes, contentType: 'multipart/form-data; boundary=x' });
		expect(r?.status).toBe(201);
		expect(raw.mock.calls[1][1]).toMatchObject({ rawBody: bytes, contentType: 'multipart/form-data; boundary=x' });
	});

	it("passes the robot's own error through (link header present)", async () => {
		raw.mockResolvedValueOnce(res(409, { message: 'busy' }, { 'x-ot2-link': 'cable', 'x-ot2-ms': '5' }));
		const r = await ot2ViaArm(robot, 'POST', '/runs/1/actions', { data: { actionType: 'play' } });
		expect(r?.status).toBe(409);
		expect(queue).not.toHaveBeenCalled();
	});
});
