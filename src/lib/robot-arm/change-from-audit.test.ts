import { describe, expect, it } from 'vitest';
import { changesFromAudit, robotSlot, type AuditNames } from './change-from-audit';
import { changeLine } from './change-labels';

const names: AuditNames = { robots: { r7: 'Robot 3 B07', r14: 'Robot 1 B14' }, protocols: { p1: 'Reagent_Fill.py' } };
const lines = (a: Parameters<typeof changesFromAudit>[0]) => changesFromAudit(a, names).map((c) => changeLine(c));

describe('changesFromAudit', () => {
	it('Setup: one row per field that changed', () => {
		const rows = lines({
			_id: 'a',
			action: 'arm_wax_fill.setup',
			tableName: 'arm_wax_fill_settings',
			recordId: 'default',
			newData: {
				robotId: 'r7',
				cartPosition: 1,
				testMode: false,
				channels: { c: true, b: false, a: false },
				chainGrab: true,
				before: { robotId: 'r7', cartPosition: 1, testMode: true, channels: { a: true }, chainGrab: true }
			}
		});
		expect(rows).toEqual(['setup.test_mode On -> Off', 'setup.channels A -> C']);
	});
	it('robot switch, by slot', () => {
		expect(lines({ _id: 'a', action: 'arm_wax_fill.switch_robot', tableName: 't', recordId: 'default', newData: { robotId: 'r7', before: { robotId: 'r14' } } })).toEqual([
			'setup.robot B14 -> B07'
		]);
	});
	it('Stage Calibration: scan position, dispense depth, cart shift, hole offsets', () => {
		expect(lines({ _id: 'a', action: 'arm_wax_fill.scan_position', tableName: 't', recordId: 'r7', newData: { x: 220.181, y: 248.047, z: 167.75, before: null } })).toEqual([
			'stage.scan_position robot:B07 220.18, 248.05, 167.75 mm'
		]);
		expect(lines({ _id: 'a', action: 'arm_wax_fill.dispense_depth', tableName: 't', recordId: 'r7', newData: { mm: 1.5, before: 0 } })).toEqual([
			'stage.dispense_depth robot:B07 0 -> 1.5 mm'
		]);
		expect(
			lines({
				_id: 'a',
				action: 'arm_wax_fill.stage_edit',
				tableName: 't',
				recordId: 'r7',
				newData: { mode: 'translate', cartLocationBefore: { x: 1, y: 2, z: 3 }, cartLocationAfter: { x: 1, y: 2, z: 0.5 } }
			})
		).toEqual(['stage.cart_location robot:B07 1, 2, 3 -> 1, 2, 0.5 mm']);
		expect(
			lines({ _id: 'a', action: 'arm_wax_fill.stage_edit', tableName: 't', recordId: 'r7', newData: { mode: 'offsets', edits: [{ wellName: 'C3', dx: 0.2, dy: 0, dz: -0.1 }] } })
		).toEqual(['stage.hole_offset robot:B07 hole:C3 dx 0.2 dy 0 dz -0.1 mm']);
	});
	it('tip calibrator: only what changed', () => {
		expect(
			lines({
				_id: 'a',
				action: 'arm_wax_fill.calibrator',
				tableName: 't',
				recordId: 'r7',
				newData: { position: { x: 287, y: 77, z: 34 }, zCalWax: 29, maxTipAdjust: 10, before: { position: { x: 287, y: 78, z: 34 }, zCalWax: 29, maxTipAdjust: 10 } }
			})
		).toEqual(['calibrator.position robot:B07 287, 78, 34 -> 287, 77, 34 mm']);
	});
	it('protocol deploys: the arm one once, the library one by file name', () => {
		expect(lines({ _id: 'a', action: 'arm_wax_fill.deploy_protocol', tableName: 'opentrons_robots', recordId: 'r7', newData: { fileName: 'Wax.py', rehearsal: false } })).toEqual([
			'ot2.protocol robot:B07 Wax.py'
		]);
		expect(lines({ _id: 'a', action: 'deploy', tableName: 'opentrons_protocols', recordId: 'lib', newData: { robotId: 'r7', from: 'arm-wax-fill' } })).toEqual([]);
		expect(lines({ _id: 'a', action: 'deploy', tableName: 'opentrons_protocols', recordId: 'p1', newData: { robotId: 'r14', analysisStatus: 'completed' } })).toEqual([
			'ot2.protocol robot:B14 Reagent_Fill.py'
		]);
	});
	it('tunnel address, conveyor default, droop trims', () => {
		expect(
			lines({
				_id: 'a',
				action: 'UPDATE',
				tableName: 'robot_arm_endpoints',
				recordId: 'tunnel',
				oldData: { url: 'https://a.trycloudflare.com' },
				newData: { url: 'https://b.trycloudflare.com' }
			})
		).toEqual(['network.tunnel_url endpoint:tunnel a.trycloudflare.com -> b.trycloudflare.com']);
		expect(lines({ _id: 'a', action: 'UPDATE', tableName: 'parts', recordId: 'x', newData: {} })).toEqual([]);
		expect(
			lines({ _id: 'a', action: 'robot_arm.conveyor.default', tableName: 't', recordId: 'default', oldData: { conveyorPulseMs: 400 }, newData: { conveyorPulseMs: 350 } })
		).toEqual(['conveyor.default_ms 400 -> 350 ms']);
		expect(lines({ _id: 'a', action: 'robot_arm.animate.pose_droop_clear', tableName: 't', recordId: 'p', newData: { name: '16. retreat', before: [-1, 300] } })).toEqual([
			'pose.droop_trim pose:16. retreat -1, 300 -> Cleared'
		]);
		expect(lines({ _id: 'a', action: 'robot_arm.animate.pose_edit', tableName: 't', recordId: 'p', newData: {} })).toEqual([]);
	});
	it('robotSlot falls back to the name, then the id', () => {
		expect(robotSlot('r7', names)).toBe('B07');
		expect(robotSlot('zz', { robots: { zz: 'Bench Bot' } })).toBe('Bench Bot');
		expect(robotSlot('qq', names)).toBe('qq');
	});
});
