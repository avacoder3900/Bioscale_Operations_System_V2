/**
 * The run-start freshness gate after the OT2-TAILNET-5 split: the robot half is
 * the shared 'run.ensureFresh' / 'run.uploadProtocol' verbs; what stays here is
 * the BIMS half. ensureFreshRunProtocol must keep its old order, results and
 * messages (fresh → no upload; stale → upload, repoint, VERIFY, audit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import analysisDetail from '$lib/opentrons/__fixtures__/run/analysis-detail.json';

const writes: Array<{ op: string; args: any[] }> = [];
let robotDoc: any;
let storedProto: any;

vi.mock('$lib/server/db', () => {
	const q = (v: () => unknown) => ({ lean: async () => v(), select: () => ({ lean: async () => v() }), sort: () => ({ lean: async () => v() }) });
	return {
		connectDB: async () => {},
		generateId: () => 'gen-id',
		OpentronsRobot: {
			findById: () => q(() => robotDoc),
			updateOne: async (...args: any[]) => writes.push({ op: 'robot.updateOne', args })
		},
		OpentronProtocol: { findOne: () => q(() => storedProto) },
		LabwareDefinition: {
			find: () =>
				q(() => [
					{ loadName: 'gen4deck_v2', definition: { wells: { A1: { x: 10.5, y: 20.25, z: 3, depth: 5 }, A2: { x: 19.5, y: 20.25, z: 3 } } } },
					{ loadName: 'unused_rack', definition: { wells: { A1: { x: 0, y: 0, z: 0 } } } }
				])
		},
		AuditLog: { create: async (doc: any) => writes.push({ op: 'audit', args: [doc] }) }
	};
});

let uploadCalls = 0;
vi.mock('./proxy', () => ({
	assembleProtocolUpload: async (_r: any, fileName: string, src: string) => ({ fileName, fileContent: src, labware: [] }),
	uploadAssembledProtocol: async () => {
		uploadCalls++;
		return { opentronsProtocolId: 'p-fresh', analysisStatus: 'completed', parametersSchema: [{ variableName: 'cartridges' }], labwareDefinitions: null, pipettesRequired: null };
	}
}));

// The robot: analyses per protocol id. p-old is stale (A2 moved), p-fresh matches.
const detailFor = (pid: string) => {
	const d = structuredClone(analysisDetail) as any;
	if (pid === 'p-old') d.data.commands[0].result.definition.wells.A2.x = 19.0;
	if (pid === 'p-bad') d.data.commands[0].result.definition.wells.A2.x = 99;
	return d;
};
vi.mock('./transport', () => ({
	serverTransport: () => ({
		get: async (path: string) => {
			const pid = path.split('/')[2];
			const body = path.endsWith('/analyses') ? { data: [{ id: 'an', status: 'completed' }] } : detailFor(verifyAs ?? pid);
			return new Response(JSON.stringify(body), { status: 200 });
		},
		post: async () => new Response('{}', { status: 500 }),
		delete: async () => new Response('{}', { status: 500 })
	})
}));
let verifyAs: string | null = null;

import { ensureFreshRunProtocol, expectedWellsFromDefs } from './protocol-freshness';

beforeEach(() => {
	writes.length = 0;
	uploadCalls = 0;
	verifyAs = null;
	storedProto = { fileName: 'wax_filling.py', fileContent: 'print(1)' };
	robotDoc = {
		protocols: [
			{ protocolType: 'wax-filling', opentronsProtocolId: 'p-older', createdAt: '2026-09-01' },
			{ protocolType: 'wax-filling', opentronsProtocolId: 'p-cur', parametersSchema: [{ variableName: 'x' }], createdAt: '2026-09-20' },
			{ protocolType: 'reagent-filling', opentronsProtocolId: 'p-r', createdAt: '2026-09-21' }
		]
	};
});

describe('expectedWellsFromDefs', () => {
	it('keeps exactly the x/y/z the diff compares, per loadName', () => {
		expect(expectedWellsFromDefs([{ loadName: 'a', definition: { wells: { A1: { x: 1, y: 2, z: 3, depth: 9 } } } }, { definition: {} } as any])).toEqual({
			a: { A1: { x: 1, y: 2, z: 3 } }
		});
	});
});

describe('ensureFreshRunProtocol (queue line, one call)', () => {
	it('fresh current entry → no upload, the entry and its schema', async () => {
		const r = await ensureFreshRunProtocol({ ip: 'x' }, 'rb1', 'wax-filling', 'op');
		expect(r).toEqual({ opentronsProtocolId: 'p-cur', parametersSchema: [{ variableName: 'x' }], refreshed: false, detail: '1 BIMS labware defs verified current' });
		expect(uploadCalls).toBe(0);
		expect(writes).toEqual([]);
	});

	it('stale → re-upload, repoint the entry, verify, then audit run_start_auto_resync', async () => {
		robotDoc.protocols[1].opentronsProtocolId = 'p-old';
		const r = await ensureFreshRunProtocol({ ip: 'x' }, 'rb1', 'wax-filling', 'op');
		expect(r).toMatchObject({ opentronsProtocolId: 'p-fresh', refreshed: true, parametersSchema: [{ variableName: 'cartridges' }] });
		expect(uploadCalls).toBe(1);
		expect(writes.map((w) => w.op)).toEqual(['robot.updateOne', 'robot.updateOne', 'audit']);
		expect(writes[0].args[1]).toEqual({ $pull: { protocols: { protocolType: 'wax-filling' } } });
		const audit = writes[2].args[0];
		expect(audit).toMatchObject({
			tableName: 'opentrons_robots',
			recordId: 'rb1',
			action: 'run_start_auto_resync',
			changedBy: 'op',
			newData: { processType: 'wax-filling', from: 'p-old', to: 'p-fresh', line: 'queue' }
		});
		expect(audit.newData.reason).toBe('gen4deck_v2 A2 bundled (19,20.25,3) != current (19.5,20.25,3)');
	});

	it('the fresh upload still stale → the old hard-gate message, no audit', async () => {
		robotDoc.protocols[1].opentronsProtocolId = 'p-old';
		verifyAs = 'p-bad'; // every analysis read — including the fresh upload's — shows moved geometry
		await expect(ensureFreshRunProtocol({ ip: 'x' }, 'rb1', 'wax-filling', 'op')).rejects.toThrow(
			"re-synced wax-filling protocol still doesn't match live calibration: gen4deck_v2 A2 bundled (99,20.25,3) != current (19.5,20.25,3)"
		);
		expect(writes.some((w) => w.op === 'audit')).toBe(false);
	});

	it('no stored .py → the old operator message', async () => {
		robotDoc.protocols = [];
		storedProto = null;
		await expect(ensureFreshRunProtocol({ ip: 'x' }, 'rb1', 'wax-filling', 'op')).rejects.toThrow(
			/Deck calibration is newer than the robot's wax-filling upload \(no protocol entry on robot\)/
		);
	});
});
