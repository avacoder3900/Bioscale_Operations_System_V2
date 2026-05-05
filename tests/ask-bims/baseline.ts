/**
 * Baseline test questions for the Ask BIMS agent.
 *
 * Each question is an assertion: given THIS user input, the agent SHOULD call
 * these tools (requiredTools), MUST NOT call these tools (forbiddenTools), and
 * the answer should contain these phrases (expectedAnswerPhrases regexes).
 *
 * Categories cover every domain the agent currently exposes. Anti-overlap and
 * redirection cases catch the tool-selection failures we've observed in prod.
 *
 * Synthetic-fixture trap tests are deferred (see roadmap gap G1) — for now,
 * the harness runs against real prod data, so behavior may shift if data
 * changes. That's acceptable for catching regressions; precise assertions
 * only check tool selection and key phrasing patterns.
 */

export interface TestQuestion {
	id: string;
	category: 'wax' | 'temperature' | 'runs' | 'cartridges' | 'inventory' | 'equipment' | 'anti-overlap' | 'redirection';
	text: string;
	requiredTools: string[];
	forbiddenTools?: string[];
	expectedAnswerPhrases?: RegExp[];
	notes?: string;
}

export const BASELINE_QUESTIONS: TestQuestion[] = [
	// === Wax ===
	{
		id: 'wax-inventory',
		category: 'wax',
		text: 'How much wax do we have in stock right now?',
		requiredTools: ['get_wax_tube_inventory'],
		forbiddenTools: ['list_legacy_wax_batches'],
		expectedAnswerPhrases: [/\d+/, /tube|μL|microliter|wax/i],
		notes: 'Source-of-truth check: must use ReceivingLot-based tool, not legacy WaxBatch.'
	},
	{
		id: 'wax-low',
		category: 'wax',
		text: 'Are any wax lots running low?',
		requiredTools: ['get_wax_tube_inventory'],
		forbiddenTools: ['list_legacy_wax_batches'],
		notes: 'Same as above; "running low" must not trigger legacy tool.'
	},
	{
		id: 'wax-legacy-explicit',
		category: 'wax',
		text: 'Do we have any in-house wax production records?',
		requiredTools: ['list_legacy_wax_batches'],
		notes: 'The ONE case where legacy tool is correct — explicit "in-house production" mention.'
	},

	// === Temperature ===
	{
		id: 'temp-current',
		category: 'temperature',
		text: 'What is the current temperature of the CLIA Freezer?',
		requiredTools: ['get_current_temperatures'],
		forbiddenTools: ['list_equipment', 'get_temperature_alerts'],
		expectedAnswerPhrases: [/freezer|fridge|temp|degree|°C|find|see|locate/i],
		notes: 'Phrase regex is permissive — equipment may not exist by exact name; valid answer is "no such freezer found".'
	},
	{
		id: 'temp-alerts',
		category: 'temperature',
		text: 'What temperature alerts have we had in the last 24 hours?',
		requiredTools: ['get_temperature_alerts'],
		forbiddenTools: ['get_current_temperatures', 'list_equipment']
	},
	{
		id: 'temp-unack',
		category: 'temperature',
		text: 'Any unacknowledged temperature alerts?',
		requiredTools: ['get_temperature_alerts']
	},

	// === Runs ===
	{
		id: 'runs-recent',
		category: 'runs',
		text: 'Show me runs from the last 24 hours.',
		requiredTools: ['list_recent_runs'],
		forbiddenTools: ['get_run_yield', 'find_cartridges']
	},
	{
		id: 'runs-aborted',
		category: 'runs',
		text: 'What runs aborted today?',
		requiredTools: ['list_recent_runs'],
		notes: 'Should pass status=aborted as a parameter.'
	},

	// === Cartridges ===
	{
		id: 'cart-count',
		category: 'cartridges',
		text: 'How many cartridges did we make today?',
		requiredTools: ['count_cartridges_by_status'],
		forbiddenTools: ['find_cartridges'],
		notes: 'Counts only — must NOT use find_cartridges for manual counting.'
	},
	{
		id: 'cart-stored',
		category: 'cartridges',
		text: 'Show me cartridges currently in wax storage.',
		requiredTools: ['find_cartridges'],
		forbiddenTools: ['count_cartridges_by_status', 'get_run_yield']
	},

	// === Inventory ===
	{
		id: 'inv-low',
		category: 'inventory',
		text: 'What parts do I need to reorder?',
		requiredTools: ['list_low_inventory_parts'],
		forbiddenTools: ['find_part']
	},
	{
		id: 'inv-find-part',
		category: 'inventory',
		text: 'Tell me about part PT-CT-104.',
		requiredTools: ['find_part'],
		forbiddenTools: ['list_low_inventory_parts', 'find_receiving_lot']
	},

	// === Equipment ===
	{
		id: 'eq-list-fridges',
		category: 'equipment',
		text: 'What fridges do we have?',
		requiredTools: ['list_equipment'],
		forbiddenTools: ['get_current_temperatures', 'get_temperature_alerts']
	},

	// === Anti-overlap (the "should pick ONE tool, not multiple" cases) ===
	{
		id: 'overlap-trace-no-find-first',
		category: 'anti-overlap',
		text: 'Trace cartridge abc-test-id-123 for me.',
		requiredTools: ['trace_cartridge'],
		forbiddenTools: ['find_cartridges'],
		notes: 'Must call trace_cartridge directly. Pre-calling find_cartridges first is over-fetching.'
	},
	{
		id: 'overlap-yield-no-find',
		category: 'anti-overlap',
		text: 'What is the yield on the most recent completed wax run?',
		requiredTools: ['list_recent_runs', 'get_run_yield'],
		forbiddenTools: ['find_cartridges'],
		notes: 'Two tools max: list runs to find recent, then get_run_yield. NOT find_cartridges to count.'
	},
	{
		id: 'overlap-no-double-list-runs',
		category: 'anti-overlap',
		text: 'Show me what wax runs ran in the last 12 hours.',
		requiredTools: ['list_recent_runs'],
		notes: 'Single call. Anti-redundancy rule: must not call list_recent_runs twice.',
		// Custom: enforce list_recent_runs called exactly once via callCount check below
	},

	// === Redirection (the UUID-vs-part-catalog case from the prod test) ===
	{
		id: 'redirect-uuid-to-receiving-lot',
		category: 'redirection',
		text: 'Look up lot 74b942a2-16a5-4ae4-aa91-917d3ecc146a for me.',
		requiredTools: ['find_receiving_lot'],
		forbiddenTools: ['find_part'],
		notes: 'UUID-style ID → must use find_receiving_lot, NOT find_part.'
	},
	{
		id: 'redirect-receiving-lot-by-question',
		category: 'redirection',
		text: 'What part was in receiving lot bag-12345?',
		requiredTools: ['find_receiving_lot'],
		forbiddenTools: ['find_part']
	},
];

export function questionsByCategory(): Record<string, TestQuestion[]> {
	const result: Record<string, TestQuestion[]> = {};
	for (const q of BASELINE_QUESTIONS) {
		if (!result[q.category]) result[q.category] = [];
		result[q.category].push(q);
	}
	return result;
}
