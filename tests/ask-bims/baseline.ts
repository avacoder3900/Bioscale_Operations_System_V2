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
	category: 'wax' | 'temperature' | 'runs' | 'cartridges' | 'inventory' | 'equipment' | 'anti-overlap' | 'redirection' | 'phase2' | 'inline-ref' | 'docs' | 'work-instructions' | 'datasheets' | 'research';
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
		requiredTools: [], // either find_cartridges OR list_cartridges_in_storage is acceptable
		forbiddenTools: ['count_cartridges_by_status', 'get_run_yield', 'trace_cartridge'],
		notes: 'Either find_cartridges(status=wax_stored) or list_cartridges_in_storage works. Both are correct; assertion is purely on forbiddenTools.',
		expectedAnswerPhrases: [/storage|stored|fridge|cart/i]
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

	// === Phase 2 — operational coverage ===
	{
		id: 'phase2-active-runs',
		category: 'phase2',
		text: 'What runs are active right now?',
		requiredTools: ['list_active_runs'],
		forbiddenTools: ['list_recent_runs']
	},
	{
		id: 'phase2-cartridges-in-storage',
		category: 'phase2',
		text: 'How many cartridges are currently in wax storage?',
		requiredTools: ['list_cartridges_in_storage'],
		notes: 'count_cartridges_by_status would also work but list_cartridges_in_storage is more specific.'
	},
	{
		id: 'phase2-calibrations-due',
		category: 'phase2',
		text: 'What equipment is due for calibration in the next 30 days?',
		requiredTools: ['list_calibrations_due'],
		forbiddenTools: ['list_equipment']
	},
	{
		id: 'phase2-temperature-history',
		category: 'phase2',
		text: 'Show me temperature history for the cartridge oven over the last 24 hours.',
		requiredTools: ['get_temperature_history'],
		forbiddenTools: ['get_current_temperatures', 'get_temperature_alerts']
	},

	// === Phase 3 — genealogy + integrity ===
	{
		id: 'phase3-data-integrity',
		category: 'phase2',
		text: 'Run a data integrity check on the system.',
		requiredTools: ['check_data_integrity']
	},
	{
		id: 'phase3-data-integrity-summary',
		category: 'phase2',
		text: 'Summarize the latest data integrity findings for me.',
		requiredTools: ['check_data_integrity'],
		notes: 'Phase 1 — exercises the cron-backed path. The tool now reads from bims_anomalies (or falls back to recompute) and returns the same shape as before. Answer should mention any of the seven checks (null wax source / stale temp / stuck cartridges / over-consumed lots / orphan refs / counter drift / legacy status).'
	},

	// === Phase 4+5 — time-series + predictive ===
	{
		id: 'phase4-throughput',
		category: 'phase2',
		text: 'How many cartridges did we make per day this week?',
		requiredTools: ['production_throughput']
	},
	{
		id: 'phase5-runway',
		category: 'phase2',
		text: 'How long will our PT-CT-104 inventory last at current consumption rates?',
		requiredTools: ['runway']
	},

	// === Inline reference (Phase A — TIER 1 grounding) ===
	{
		id: 'inline-ref-sacred-rule',
		category: 'inline-ref',
		text: "Why can't I edit a finalized cartridge's rawData?",
		requiredTools: [],
		forbiddenTools: ['find_cartridges', 'trace_cartridge', 'check_data_integrity', 'count_cartridges_by_status'],
		expectedAnswerPhrases: [/sacred/i, /correction/i, /finaliz/i],
		notes: 'Phase A — pure tier-rule question. Should answer from inlined DATA-REFERENCE §1 + sacred middleware semantics, no tool calls. Forbidden tools cover the most likely over-fetch traps.'
	},
	{
		id: 'inline-ref-integrity-gap',
		category: 'inline-ref',
		text: 'How accurate is the wax-source-lot tracking on recent wax runs?',
		requiredTools: [],
		expectedAnswerPhrases: [/null|missing|incomplete|orphan|untraceable/i, /waxSourceLot|wax source|source lot/i],
		notes: 'Phase A — integrity-gap awareness. Either grounds in §4 directly OR uses list_recent_runs/check_data_integrity to confirm and surface the dataIntegrityNotes. Both paths are acceptable; assertion is on the answer mentioning the gap.'
	},
	{
		id: 'inline-ref-schema-relationship',
		category: 'inline-ref',
		text: 'What field links a cartridge_records document to its wax filling run?',
		requiredTools: [],
		forbiddenTools: ['find_cartridges', 'trace_cartridge', 'list_recent_runs'],
		expectedAnswerPhrases: [/waxFilling/i, /runId|wax_filling_runs|WaxFillingRun/i],
		notes: 'Phase A — pure schema-relationship recall. Should answer from inlined §2 (cartridge_records line) without fetching any data. Forbidden tools cover over-fetching for what is fundamentally a schema question.'
	},

	// === Docs search (Phase B — search_documentation tool) ===
	{
		id: 'docs-search-mfg-flow-gap',
		category: 'docs',
		text: 'What does the manufacturing flow audit say about laser cutting?',
		requiredTools: ['search_documentation'],
		expectedAnswerPhrases: [/laser/i, /isolated|disconnect|no link|missing|broken/i],
		notes: 'Phase B — exercises search_documentation against MANUFACTURING-FLOW-AUDIT.md (gap #1: LaserCutBatch is isolated). Question is phrased so the natural keyword query is "laser cutting" (2 words, present in the doc) rather than a 3+ word phrase that the substring-search tool would miss.'
	},
	{
		id: 'docs-search-recent-fixes',
		category: 'docs',
		text: 'What recent manufacturing fixes are documented in our AUDIT-CHECK-SUMMARY?',
		requiredTools: ['search_documentation'],
		expectedAnswerPhrases: [/AUDIT-CHECK|audit.check/i],
		notes: 'Phase B — exercises search_documentation by doc-title reference. Answer should cite the file and surface at least one fix from the audit summary.'
	},

	// === Work instructions search (Phase C — search_work_instructions tool) ===
	{
		id: 'wi-search-by-number',
		category: 'work-instructions',
		text: 'What does WI-01 cover?',
		requiredTools: ['search_work_instructions'],
		forbiddenTools: ['search_documentation'],
		expectedAnswerPhrases: [/WI-?01/i],
		notes: 'Phase C — find by document number. Should NOT route to search_documentation (markdown corpus); WIs live in their own model.'
	},
	{
		id: 'wi-search-by-keyword',
		category: 'work-instructions',
		text: 'Show me the work instruction for thermoseal cutting.',
		requiredTools: ['search_work_instructions'],
		expectedAnswerPhrases: [/thermoseal|seal/i],
		notes: 'Phase C — find by step keyword. Tool searches step title/content for "thermoseal".'
	},
	{
		id: 'wi-search-by-part',
		category: 'work-instructions',
		text: 'Which work instructions require part PT-CT-114?',
		requiredTools: ['search_work_instructions'],
		expectedAnswerPhrases: [/PT-CT-114/i],
		notes: 'Phase C — find by partNumber filter. Agent should pass partNumber=PT-CT-114 to narrow. Result enumerates WIs whose current-version steps have that part requirement.'
	},

	// === Equipment datasheets (Phase D — lookup_equipment_datasheet tool) ===
	{
		id: 'datasheet-by-tag',
		category: 'datasheets',
		text: 'What are the specs on equipment B-01?',
		requiredTools: ['lookup_equipment_datasheet'],
		forbiddenTools: ['list_equipment', 'get_current_temperatures'],
		expectedAnswerPhrases: [/B-?01/i, /fridge|refrigerator|cooler/i],
		notes: 'Phase D — lookup by Tag # (B-01 = tall glass door fridge in BT). Should NOT route to list_equipment (live registry, no datasheet specs).'
	},
	{
		id: 'datasheet-by-name',
		category: 'datasheets',
		text: 'Where is the biosafety cabinet located and what is its power draw?',
		requiredTools: ['lookup_equipment_datasheet'],
		forbiddenTools: ['list_equipment'],
		expectedAnswerPhrases: [/biosafety|safety cabinet/i, /tissue|culture|F-?01|location/i],
		notes: 'Phase D — fuzzy name match returns Fannin F-01 row (Tissue Culture lab, 120V/1150W/10A). Datasheet URL should be surfaced.'
	},

	// === Chemical inventory (Phase 2 — lookup_chemical tool) ===
	{
		id: 'chemical-by-name',
		category: 'datasheets',
		text: 'Where is the methanol stored and how much do we have?',
		requiredTools: ['lookup_chemical'],
		forbiddenTools: ['find_part', 'list_reagent_catalog', 'list_reagent_inventory'],
		expectedAnswerPhrases: [/methanol/i, /C-?013|brevitest|fannin|flammable|F1B|TOX/i],
		notes: 'Phase 2 — name-based lookup. C-013 Methanol (1L + 1L) lives in Brevitest. Should NOT route to part-catalog or reagent-catalog tools.'
	},
	{
		id: 'chemical-by-tag',
		category: 'datasheets',
		text: 'Tell me about chemical C-042.',
		requiredTools: ['lookup_chemical'],
		forbiddenTools: ['find_part', 'find_receiving_lot'],
		expectedAnswerPhrases: [/glycerol|C-?042/i],
		notes: 'Phase 2 — Inventory Code lookup. C-042 is Glycerol (Brevitest). Glycerol is dual-stocked with Fannin, so the answer may surface that note as well.'
	},
	{
		id: 'chemical-by-cas',
		category: 'datasheets',
		text: 'Do we have anything on file with CAS 67-56-1?',
		requiredTools: ['lookup_chemical'],
		forbiddenTools: ['find_part', 'search_documentation'],
		expectedAnswerPhrases: [/67-56-1|methanol|C-?013|C-?017/i],
		notes: 'Phase 2 — CAS-number lookup. 67-56-1 is methanol; matches both C-013 (Methanol neat) and C-017 (Coomassie reagent that contains methanol). Should NOT route to part-catalog.'
	},

	// === Floor plan (Phase 3 — find_location tool) ===
	{
		id: 'location-by-tag',
		category: 'datasheets',
		text: 'Where is fridge B-01?',
		requiredTools: ['find_location'],
		forbiddenTools: ['list_equipment', 'get_current_temperatures'],
		expectedAnswerPhrases: [/B-?01|manufacturing|fridge/i],
		notes: 'Phase 3 — tag-based resolution. B-01 (tall glass door fridge) lives in Manufacturing per the BT CSV. Should NOT route to list_equipment.'
	},
	{
		id: 'location-by-zone',
		category: 'datasheets',
		text: "What's in tissue culture?",
		requiredTools: ['find_location'],
		forbiddenTools: ['list_equipment'],
		expectedAnswerPhrases: [/tissue culture|biosafety|F-?01|fannin/i],
		notes: 'Phase 3 — zone-based listing. Tissue Culture is the Fannin-owned enclosed room with the biosafety cabinet (F-01). Should NOT route to list_equipment (live registry, no zone semantics).'
	},

	// === Research-side Phase E1: experiment + cartridge research tools ===
	{
		id: 'research-experiments-underway',
		category: 'research',
		text: 'What research experiments are currently underway?',
		requiredTools: ['list_experiments'],
		forbiddenTools: ['find_cartridges', 'list_recent_runs', 'list_active_runs'],
		expectedAnswerPhrases: [/experiment/i],
		notes: 'Phase E1 — list_experiments with implicit status=underway filter. Should NOT route to find_cartridges or list_active_runs (those are mfg-side, not research experiments).'
	},
	{
		id: 'research-cart-result',
		category: 'research',
		text: 'What is the test result and analysis status for cartridge 5da7b3c5-4cba-4fe4-93b1-c17ad61efbbf?',
		requiredTools: ['find_research_cartridge'],
		forbiddenTools: ['trace_cartridge', 'backward_genealogy'],
		expectedAnswerPhrases: [/cart|result|not found|no cartridge/i],
		notes: 'Phase E1 — find_research_cartridge for research-side fields (result, analysis, reagentChain, rawData). Should NOT route to trace_cartridge/backward_genealogy (those are mfg lineage). UUID may not exist in DB — graceful "not found" is acceptable.'
	},

	// === Phase E2: reagent catalog + inventory tools ===
	{
		id: 'research-list-antibodies',
		category: 'research',
		text: 'What antibody types do we have in the reagent catalog?',
		requiredTools: ['list_reagent_catalog'],
		forbiddenTools: ['list_low_inventory_parts', 'find_part'],
		expectedAnswerPhrases: [/antibody|antibodies|catalog/i],
		notes: 'Phase E2 — list_reagent_catalog with category=antibody. Should NOT route to part-catalog tools (list_low_inventory_parts/find_part are for the BIMS PartDefinition catalog, not the research reagent catalog).'
	},
	{
		id: 'research-inventory-by-variant',
		category: 'research',
		text: 'How much Active Beads — Cortisol do we have on hand, broken down by variant?',
		requiredTools: ['count_inventory_by_variant'],
		expectedAnswerPhrases: [/variant|cortisol|active bead/i],
		notes: 'Phase E2 — by-variant rollup. Agent should first find_reagent_catalog to get the catalogId, then count_inventory_by_variant to get the per-variant counts. Critical: list_reagent_inventory without a variantKey filter would silently pool different antibody clones — that\'s why count_inventory_by_variant exists.'
	},

	// === Phase E3: protocol research tools ===
	{
		id: 'research-list-active-protocols',
		category: 'research',
		text: 'What active conjugation protocols do we have?',
		requiredTools: ['list_protocols'],
		forbiddenTools: ['search_documentation', 'find_protocol'],
		expectedAnswerPhrases: [/conjugation|protocol/i],
		notes: 'Phase E3 — list_protocols with category=conjugation. Should NOT route to search_documentation (markdown corpus, not structured protocols). find_protocol is for single-protocol lookups.'
	},
	{
		id: 'research-find-protocol-cellmap-warning',
		category: 'research',
		text: 'Show me the Active Beads v3 protocol details.',
		requiredTools: ['find_protocol'],
		forbiddenTools: ['list_protocols', 'list_protocol_executions'],
		expectedAnswerPhrases: [/active beads|protocol|step|parameter|cellMap|formula/i],
		notes: 'Phase E3 — find_protocol on a name that exists in Mongo. As of 2026-05-11 the only Active Beads protocol live is v3 (Double Active Bead). The cellMap-empty integrity warning is currently dormant (v3 has 14 cellMap keys) — if a future protocol with cellMap={} appears, this fixture will exercise that warning automatically. Forbidden list_protocols catches the browse-then-narrow fallback.'
	},

	// === Phase E4: trace_reagent_chain (recursive grail tool) ===
	{
		id: 'research-trace-reagent-chain',
		category: 'research',
		text: 'Trace the reagent chain for cartridge wjIuzcKhQkysJ80hQyatq — which protocol executions produced its reagents?',
		requiredTools: ['trace_reagent_chain'],
		forbiddenTools: ['trace_cartridge', 'backward_genealogy', 'find_research_cartridge'],
		expectedAnswerPhrases: [/reagent|provenance|chain|stock|empty|deferred|attach/i],
		notes: 'Phase E4 — recursive reagent traceability against a real BIMS cart. Most carts in Mongo today have reagentChain[]=[] per integrity gap #3 (Jacob\'s deferred attach UI), so the agent should surface the empty-chain dataIntegrityNote. NOT trace_cartridge/backward_genealogy (mfg-side lineage). Cart ID refreshed from Mongo 2026-05-11.'
	},
	{
		id: 'research-trace-empty-chain-awareness',
		category: 'research',
		text: 'Run trace_reagent_chain on cart abc-not-real-test-id and tell me what it returns.',
		requiredTools: ['trace_reagent_chain'],
		expectedAnswerPhrases: [/not found|no cartridge|empty|no chain|deferred|attach|doesn't exist|does not exist|could not be (found|located)|couldn't (find|locate)|unable to (find|locate)|no such|no record/i],
		notes: 'Phase E4 — graceful not-found handling. Question is now directive ("Run trace_reagent_chain on...") so the agent goes straight to the tool rather than verifying existence via find_research_cartridge first. Tool returns {found:false, dataIntegrityNotes:[\"No cartridge found with barcode...\"]}.'
	},

	// === Phase E5: samples + analytes + analysis profiles + calibrated analyses ===
	{
		id: 'research-list-analytes',
		category: 'research',
		text: 'What analytes do we measure and what are their reference ranges?',
		requiredTools: ['list_analytes'],
		forbiddenTools: ['list_low_inventory_parts', 'find_part', 'list_reagent_catalog'],
		expectedAnswerPhrases: [/analyte|reference range|units|measure/i],
		notes: 'Phase E5 — list_analytes returns research-side measurement targets with units, dynamicRange, lod, loq, referenceRange. Should NOT route to part-catalog or reagent-catalog tools.'
	}
];

export function questionsByCategory(): Record<string, TestQuestion[]> {
	const result: Record<string, TestQuestion[]> = {};
	for (const q of BASELINE_QUESTIONS) {
		if (!result[q.category]) result[q.category] = [];
		result[q.category].push(q);
	}
	return result;
}
