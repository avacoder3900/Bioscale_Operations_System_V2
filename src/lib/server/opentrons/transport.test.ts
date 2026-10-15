/**
 * The server line for the OT2-TAILNET-5 upload: a FormData body on
 * serverTransport must land in proxy.ts's multipart path, which on Vercel is the
 * SAME `upload_protocol` bridge job the queue always used (byte-identical
 * payload), and on the lab LAN a multipart POST with `opentrons-version: *`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const created: any[] = [];
const fetchCalls: Array<{ url: string; init: any }> = [];

vi.mock('$lib/server/db', () => {
	const lean = (v: unknown) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
	return {
		connectDB: async () => {},
		generateId: () => 'cmd-1',
		ScannerEvent: {},
		OpentronsRobot: {},
		LabwareDefinition: {
			find: () => ({
				select: () => ({
					lean: async () => [
						{ fileName: 'gen4deck_v2.json', loadName: 'gen4deck_v2', definition: { parameters: { loadName: 'gen4deck_v2' }, wells: { A1: { x: 1 } } } },
						{ fileName: null, loadName: 'custom_2ml_24_tube_rack', definition: { ordering: [['A1']] } }
					]
				})
			})
		},
		Ot2BridgeCommand: {
			create: async (doc: any) => {
				created.push(doc);
				return doc;
			},
			findById: () =>
				lean({
					status: 'completed',
					result: {
						body: {
							opentronsProtocolId: 'proto-q',
							analysisStatus: 'completed',
							parametersSchema: [{ variableName: 'cartridges' }],
							labwareDefinitions: null,
							pipettesRequired: null
						}
					}
				}),
			updateOne: () => ({ catch: () => {} })
		}
	};
});
vi.mock('$lib/server/services/deck-calibration/rollout', () => ({ isHardenedRobot: () => false, rolloutNote: () => 'off' }));
vi.mock('./maintenance-records', () => ({ applyMaintenanceRecord: async () => ({}) }));

import { serverTransport } from './transport';
import { robotUploadProtocol, assembleProtocolUpload } from './proxy';
import { buildProtocolForm } from '$lib/opentrons/ot2-protocol';

const ROBOT = { _id: 'rb1', name: 'Robot 3 B07', ip: '10.0.0.7', port: 31950 };
const PY = new TextEncoder().encode('# wax\nfrom opentrons import protocol_api\nmetadata = {"x": "é"}\n');

const savedVercel = process.env.VERCEL;
const savedTransport = process.env.OT2_TRANSPORT;
beforeEach(() => {
	created.length = 0;
	fetchCalls.length = 0;
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.stubGlobal('fetch', async (url: string, init: any) => {
		fetchCalls.push({ url, init });
		return new Response(JSON.stringify({ data: { id: 'proto-d' } }), { status: 201, headers: { 'content-type': 'application/json' } });
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (savedVercel === undefined) delete process.env.VERCEL;
	else process.env.VERCEL = savedVercel;
	if (savedTransport === undefined) delete process.env.OT2_TRANSPORT;
	else process.env.OT2_TRANSPORT = savedTransport;
});

describe('serverTransport + FormData (the queue upload)', () => {
	it('bridge: robotUploadProtocol enqueues the same upload_protocol payload as before the split', async () => {
		process.env.OT2_TRANSPORT = 'bridge';
		const up = await robotUploadProtocol(ROBOT, 'wax_filling.py', PY);
		expect(up).toEqual({
			opentronsProtocolId: 'proto-q',
			analysisStatus: 'completed',
			parametersSchema: [{ variableName: 'cartridges' }],
			labwareDefinitions: null,
			pipettesRequired: null
		});
		expect(created).toHaveLength(1);
		const cmd = created[0];
		expect(cmd.kind).toBe('upload_protocol');
		expect(cmd.deviceId).toBe('ot2-b07-bridge');
		// The pre-split payload: base64 of the exact .py bytes + each labware JSON.
		expect(cmd.payload).toEqual({
			fileName: 'wax_filling.py',
			fileB64: Buffer.from(PY).toString('base64'),
			labware: [
				{ fileName: 'gen4deck_v2.json', b64: Buffer.from(JSON.stringify({ parameters: { loadName: 'gen4deck_v2' }, wells: { A1: { x: 1 } } })).toString('base64') },
				{ fileName: 'custom_2ml_24_tube_rack.json', b64: Buffer.from(JSON.stringify({ ordering: [['A1']] })).toString('base64') }
			]
		});
		expect(fetchCalls).toHaveLength(0); // never a raw robot fetch from the server on the bridge
	});

	it('bridge: a text .py (stored protocol) and a byte .py give the same payload', async () => {
		process.env.OT2_TRANSPORT = 'bridge';
		const text = new TextDecoder().decode(PY);
		const fromText = await assembleProtocolUpload(ROBOT, 'wax_filling.py', text);
		await serverTransport(ROBOT).post('/protocols', buildProtocolForm(fromText));
		expect(created[0].payload.fileB64).toBe(Buffer.from(PY).toString('base64'));
	});

	it('direct (lab LAN): a multipart POST /protocols with opentrons-version *, body passed through', async () => {
		process.env.OT2_TRANSPORT = 'direct';
		const form = buildProtocolForm({ fileName: 'x.py', fileContent: 'print(1)', labware: [] });
		const res = await serverTransport(ROBOT).post('/protocols', form, { timeoutMs: 110_000 });
		expect(res.status).toBe(201);
		expect(fetchCalls[0].url).toBe('http://10.0.0.7:31950/protocols');
		expect(fetchCalls[0].init.method).toBe('POST');
		expect(fetchCalls[0].init.body).toBe(form);
		expect(fetchCalls[0].init.headers).toEqual({ 'opentrons-version': '*' });
		expect(created).toHaveLength(0);
	});

	it('a JSON body still goes through robotPost (kind http on the bridge)', async () => {
		process.env.OT2_TRANSPORT = 'bridge';
		const t = serverTransport(ROBOT);
		// Don't wait out the relay: only the enqueued command matters here.
		void t.post('/runs', { data: { protocolId: 'p' } }).catch(() => {});
		await new Promise((r) => setTimeout(r, 10));
		expect(created[0]).toMatchObject({ kind: 'http', request: { method: 'POST', path: '/runs', body: { data: { protocolId: 'p' } } } });
	});

	it('multipart to any path but /protocols is refused on the bridge', async () => {
		process.env.OT2_TRANSPORT = 'bridge';
		await expect(serverTransport(ROBOT).post('/dataFiles', new FormData())).rejects.toThrow(/not supported over the bridge/);
	});
});
