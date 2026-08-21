/**
 * PERM-05 unit tests — the parts that need no DB.
 * Run: npm run test:unit
 */
import { describe, it, expect } from 'vitest';
import {
	assertHumanOnly,
	HumanOnlyError,
	HUMAN_ONLY_ACTIONS,
	humanOnlyMessage,
	MISSING_ACTOR_MESSAGE,
	unknownActorMessage
} from './machine-actor';

describe('assertHumanOnly — bots are permanent non-admins', () => {
	it('refuses every admin-gated action', () => {
		for (const id of Object.keys(HUMAN_ONLY_ACTIONS)) {
			expect(() => assertHumanOnly(id)).toThrow(HumanOnlyError);
		}
	});

	it('allows ordinary operator-level actions', () => {
		for (const id of ['kanban_capture', 'kanban_process', 'send_message', 'kanban_reorder_project']) {
			expect(() => assertHumanOnly(id)).not.toThrow();
		}
	});

	it('covers both directions of the commitment point', () => {
		expect(() => assertHumanOnly('kanban_replenish')).toThrow();
		expect(() => assertHumanOnly('kanban_demote')).toThrow();
		// reordering the committed queue is a commitment decision; project-level is not
		expect(() => assertHumanOnly('kanban_reorder_ready')).toThrow();
		expect(() => assertHumanOnly('kanban_reorder_project')).not.toThrow();
	});
});

describe('refusal messages are written to be acted on by the model', () => {
	it('missing actor tells it to ask, not to guess or self-name', () => {
		expect(MISSING_ACTOR_MESSAGE).toMatch(/ask/i);
		expect(MISSING_ACTOR_MESSAGE).toMatch(/not guess/i);
		expect(MISSING_ACTOR_MESSAGE).toMatch(/reuse/i);
	});

	it('unknown actor names the rejected value and states nothing happened', () => {
		const msg = unknownActorMessage('nobody');
		expect(msg).toContain('"nobody"');
		expect(msg).toMatch(/not performed/i);
	});

	it('human-only names the action and where a person does it', () => {
		const msg = humanOnlyMessage('Committing work', 'Kanban → Inventory');
		expect(msg).toContain('Committing work');
		expect(msg).toContain('Kanban → Inventory');
		expect(msg).toMatch(/human-only/i);
	});
});
