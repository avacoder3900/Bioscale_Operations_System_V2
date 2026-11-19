import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { missingDeclaredParams } from './declared-params';

const py = `
    parameters.add_bool(variable_name="tiprack_refilled", display_name="Tiprack Refilled", default=False)
    parameters.add_int(variable_name='bims_next_tip_index', display_name="BIMS next tip", default=-1)
    parameters.add_float(variable_name="vol_gate1", display_name="Wax Gate 1 Volume", default=1.6)
`;

describe('missingDeclaredParams', () => {
	it('names every declared parameter the analysis dropped (the 2026-11-19 cut at tiprack_refilled)', () => {
		expect(missingDeclaredParams(py, [{ variableName: 'tiprack_refilled' }])).toEqual(['bims_next_tip_index', 'vol_gate1']);
	});
	it('is empty when the robot took them all, and treats a missing list as none taken', () => {
		expect(missingDeclaredParams(py, [{ variableName: 'tiprack_refilled' }, { variableName: 'bims_next_tip_index' }, { variableName: 'vol_gate1' }])).toEqual([]);
		expect(missingDeclaredParams(py, null)).toHaveLength(3);
	});
	it('the stage protocols keep every RTP display name ≤ 30 and description ≤ 100 characters', () => {
		for (const f of ['protocols/Wax_Filling_GEN7_ArmStage.py', 'protocols/Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py']) {
			const s = fs.readFileSync(f, 'utf8');
			for (const m of s.matchAll(/(display_name|description)="([^"]*)"/g)) {
				expect(m[2].length, `${f}: ${m[1]} "${m[2].slice(0, 40)}…"`).toBeLessThanOrEqual(m[1] === 'display_name' ? 30 : 100);
			}
		}
	});
});
