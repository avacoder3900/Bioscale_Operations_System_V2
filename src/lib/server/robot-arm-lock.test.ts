import { describe, it, expect, vi } from 'vitest';

// Loop progress for a multi-loop replay comes from the run's event timeline,
// not from the Pi's /sessions/active (which only says run_id + kind).

vi.mock('$lib/server/db/models', () => ({ RobotArmRun: {} }));

import { replayLoopFromEvents } from './robot-arm-lock';

describe('replayLoopFromEvents', () => {
	it('uses the latest replay.loop event', () => {
		const events = [
			{ type: 'replay.start', payload: { loops: 5 } },
			{ type: 'replay.loop', payload: { index: 1, of: 5 } },
			{ type: 'replay.settle', payload: { settle: [] } },
			{ type: 'replay.loop', payload: { index: 3, of: 5 } }
		];
		expect(replayLoopFromEvents(events)).toEqual({ index: 3, of: 5 });
	});

	it('falls back to loop 1 of the announced count before the first loop event', () => {
		expect(replayLoopFromEvents([{ type: 'replay.start', payload: { loops: 4 } }])).toEqual({
			index: 1,
			of: 4
		});
	});

	it('is null for runs that never reported loops', () => {
		expect(replayLoopFromEvents([{ type: 'replay.start', payload: {} }])).toBeNull();
		expect(replayLoopFromEvents([])).toBeNull();
		expect(replayLoopFromEvents(undefined)).toBeNull();
	});

	it('ignores malformed loop payloads and keeps looking back', () => {
		const events = [
			{ type: 'replay.loop', payload: { index: 2, of: 3 } },
			{ type: 'replay.loop', payload: { index: 'x', of: 3 } },
			{ type: 'replay.loop', payload: null }
		];
		expect(replayLoopFromEvents(events)).toEqual({ index: 2, of: 3 });
	});

	it('never reports an index past the total', () => {
		expect(replayLoopFromEvents([{ type: 'replay.loop', payload: { index: 4, of: 3 } }])).toEqual({
			index: 4,
			of: 4
		});
	});
});
