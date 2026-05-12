/**
 * Run a curated set of ~50 acceptance questions through askBims() and emit a
 * markdown report for human grading. No assertions — purely captures the
 * answer, the tools fired, the confidence signal, and the cost per question
 * so the user can read all the answers in one pass and grade for accuracy.
 *
 * Run with: npx tsx scripts/run-acceptance.ts [--model haiku|sonnet|opus]
 */
import mongoose from 'mongoose';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { askBims, type AskBimsModel } from '../src/lib/server/ask-bims.js';

dotenv.config();

interface AcceptanceQ {
	id: string;
	section: string;
	question: string;
	intent: string; // one-line description of what we're testing
}

// Curated 50 — covers Sections 0-12 of docs/ask-bims-acceptance-testing.md.
// Real IDs from Mongo (cart wjIuzcKhQkysJ80hQyatq, Active Beads v3, etc.) so
// answers will be substantive rather than not-found.
const QUESTIONS: AcceptanceQ[] = [
	// === Section 0 — smoke ===
	{ id: 'S0.1', section: '0 — Smoke', question: 'hello', intent: 'Greeting; should call zero tools.' },
	{ id: 'S0.2', section: '0 — Smoke', question: 'what can you do?', intent: 'Capability summary; zero tools.' },

	// === Section 1 — Phase A inline TIER 1 ref ===
	{ id: 'S1.1', section: '1 — Phase A: TIER 1 inline ref', question: "Why can't I edit a finalized cartridge record?", intent: 'Answers from §1 of TIER 1 (sacred middleware) without calling tools.' },
	{ id: 'S1.2', section: '1 — Phase A: TIER 1 inline ref', question: 'Which collections are immutable?', intent: 'Lists immutable collections from §1.' },
	{ id: 'S1.3', section: '1 — Phase A: TIER 1 inline ref', question: 'Is the FREEZE-02 enforcement live yet?', intent: 'Should answer "no" citing §4 integrity gap #4.' },
	{ id: 'S1.4', section: '1 — Phase A: TIER 1 inline ref', question: 'What field links a cartridge_records document to its wax filling run?', intent: 'Schema relationship — answer from §2 without fetching.' },

	// === Section 2 — Phase B docs search ===
	{ id: 'S2.1', section: '2 — Phase B: search_documentation', question: 'What does the manufacturing flow audit say about laser cutting?', intent: 'search_documentation → MANUFACTURING-FLOW-AUDIT.md (gap #1: LaserCutBatch isolated).' },
	{ id: 'S2.2', section: '2 — Phase B: search_documentation', question: 'What recent manufacturing fixes did we deploy?', intent: 'search_documentation → AUDIT-CHECK-SUMMARY.md.' },
	{ id: 'S2.3', section: '2 — Phase B: search_documentation', question: 'How does the magnetometer system work?', intent: 'search_documentation → magnetometer-system-overview.md.' },
	{ id: 'S2.4', section: '2 — Phase B: search_documentation', question: 'Show me our PRD for particle-driven testing.', intent: 'Allowlist test — docs/prds/ must be EXCLUDED. Agent should say nothing matched (correct).' },

	// === Section 3 — Phase C work instructions ===
	{ id: 'S3.1', section: '3 — Phase C: search_work_instructions', question: 'What does WI-01 cover?', intent: 'search_work_instructions → WI-01 with version + effective date citation.' },
	{ id: 'S3.2', section: '3 — Phase C: search_work_instructions', question: 'Which work instructions require part PT-CT-114?', intent: 'search_work_instructions with partNumber filter.' },
	{ id: 'S3.3', section: '3 — Phase C: search_work_instructions', question: 'Find a step about scanning a barcode.', intent: 'search_work_instructions with step keyword.' },

	// === Section 4 — Phase D equipment datasheets ===
	{ id: 'S4.1', section: '4 — Phase D: lookup_equipment_datasheet', question: 'What are the specs on equipment B-01?', intent: 'lookup_equipment_datasheet by Tag #; should hit BT.csv.' },
	{ id: 'S4.2', section: '4 — Phase D: lookup_equipment_datasheet', question: 'Where is the biosafety cabinet located?', intent: 'Fuzzy match should hit Fannin F-01.' },
	{ id: 'S4.3', section: '4 — Phase D: lookup_equipment_datasheet', question: 'Find datasheets for any centrifuge.', intent: 'Multi-result return from either CSV.' },

	// === Section 5 — Phase E1 research experiments + cartridges ===
	{ id: 'S5.1', section: '5 — Phase E1: research experiments + carts', question: 'What research experiments are currently underway?', intent: 'list_experiments with status=underway.' },
	{ id: 'S5.2', section: '5 — Phase E1: research experiments + carts', question: 'What is the test result for cartridge wjIuzcKhQkysJ80hQyatq?', intent: 'find_research_cartridge — real cart, status=linked.' },
	{ id: 'S5.3', section: '5 — Phase E1: research experiments + carts', question: 'For a real experiment, list its first arm and its cartridges.', intent: 'Two-step: list_experiments then get_experiment_arm_cartridges.' },

	// === Section 6 — Phase E2 reagent catalog + inventory ===
	{ id: 'S6.1', section: '6 — Phase E2: reagent catalog + inventory', question: 'What antibody types do we have in the reagent catalog?', intent: 'list_reagent_catalog filtered by antibody category.' },
	{ id: 'S6.2', section: '6 — Phase E2: reagent catalog + inventory', question: 'How many active reagent items do we have right now?', intent: 'list_reagent_inventory with status=active. ~324 per memory.' },
	{ id: 'S6.3', section: '6 — Phase E2: reagent catalog + inventory', question: 'How much Active Beads — Cortisol do we have on hand, broken down by variant?', intent: 'count_inventory_by_variant — variant-aware rollup. DOMAIN-26.' },
	{ id: 'S6.4', section: '6 — Phase E2: reagent catalog + inventory', question: 'What reagents are nearing expiry in the next 30 days?', intent: 'list_reagent_inventory with nearExpiryDays=30.' },

	// === Section 7 — Phase E3 protocols ===
	{ id: 'S7.1', section: '7 — Phase E3: protocols', question: 'What active conjugation protocols do we have?', intent: 'list_protocols with category=conjugation.' },
	{ id: 'S7.2', section: '7 — Phase E3: protocols', question: 'Show me the Active Beads v3 protocol details.', intent: 'find_protocol — real protocol, 14 cellMap keys, status=active.' },
	{ id: 'S7.3', section: '7 — Phase E3: protocols', question: 'Show me recent protocol executions.', intent: 'list_protocol_executions.' },

	// === Section 8 — Phase E4 trace_reagent_chain ===
	{ id: 'S8.1', section: '8 — Phase E4: trace_reagent_chain', question: 'Trace the reagent chain for cartridge wjIuzcKhQkysJ80hQyatq.', intent: 'Real cart; expect empty-chain integrity note per gap #3.' },
	{ id: 'S8.2', section: '8 — Phase E4: trace_reagent_chain', question: 'Run trace_reagent_chain on cart abc-not-real-test-id and tell me what it returns.', intent: 'Not-found path; graceful failure.' },

	// === Section 9 — Phase E5 samples + analytes ===
	{ id: 'S9.1', section: '9 — Phase E5: samples + analytes', question: 'What analytes do we measure and what are their reference ranges?', intent: 'list_analytes.' },
	{ id: 'S9.2', section: '9 — Phase E5: samples + analytes', question: 'Show me our analysis profiles.', intent: 'list_analysis_profiles.' },
	{ id: 'S9.3', section: '9 — Phase E5: samples + analytes', question: 'List calibrated analyses we have configured.', intent: 'list_calibrated_analyses.' },

	// === Section 10 — Regression sanity on pre-existing tools ===
	{ id: 'S10.1', section: '10 — Pre-existing tool regression', question: 'How much wax do we have in stock right now?', intent: 'get_wax_tube_inventory (NOT list_legacy_wax_batches).' },
	{ id: 'S10.2', section: '10 — Pre-existing tool regression', question: 'Any in-house wax production records?', intent: 'list_legacy_wax_batches — the ONE case for the legacy tool.' },
	{ id: 'S10.3', section: '10 — Pre-existing tool regression', question: 'Are any wax lots running low?', intent: 'get_wax_tube_inventory; surfaces consumedUl vs quantity.' },
	{ id: 'S10.4', section: '10 — Pre-existing tool regression', question: 'What is the current temperature of the cartridge oven?', intent: 'get_current_temperatures.' },
	{ id: 'S10.5', section: '10 — Pre-existing tool regression', question: 'What temperature alerts have we had in the last 24 hours?', intent: 'get_temperature_alerts.' },
	{ id: 'S10.6', section: '10 — Pre-existing tool regression', question: 'Show me runs from the last 24 hours.', intent: 'list_recent_runs.' },
	{ id: 'S10.7', section: '10 — Pre-existing tool regression', question: 'How many cartridges did we make today?', intent: 'count_cartridges_by_status (NOT find_cartridges + manual count).' },
	{ id: 'S10.8', section: '10 — Pre-existing tool regression', question: 'Look up part PT-CT-114.', intent: 'find_part — should NOT redirect to find_receiving_lot for PT- prefix.' },
	{ id: 'S10.9', section: '10 — Pre-existing tool regression', question: 'Look up lot 74b942a2-16a5-4ae4-aa91-917d3ecc146a.', intent: 'Rule H — UUID routes to find_receiving_lot, NOT find_part.' },
	{ id: 'S10.10', section: '10 — Pre-existing tool regression', question: 'What parts are running low?', intent: 'list_low_inventory_parts.' },
	{ id: 'S10.11', section: '10 — Pre-existing tool regression', question: 'Are any calibrations overdue?', intent: 'list_calibrations_due.' },
	{ id: 'S10.12', section: '10 — Pre-existing tool regression', question: 'How is data integrity looking across the system?', intent: 'check_data_integrity meta-tool.' },
	{ id: 'S10.13', section: '10 — Pre-existing tool regression', question: 'What is our production throughput in the last 7 days?', intent: 'production_throughput.' },
	{ id: 'S10.14', section: '10 — Pre-existing tool regression', question: 'When does PT-CT-114 run out at current burn rate?', intent: 'runway — should surface inventoryCount drift if present.' },

	// === Section 11 — anti-redundancy + tool-selection ===
	{ id: 'S11.1', section: '11 — Tool selection / anti-overlap', question: "What's going on the floor right now?", intent: 'Broad question — should pick 2-3 tools max, not 5+.' },
	{ id: 'S11.2', section: '11 — Tool selection / anti-overlap', question: 'Is the cartridge oven on right now?', intent: 'Must call a tool; should NOT guess from prior knowledge.' },
	{ id: 'S11.3', section: '11 — Tool selection / anti-overlap', question: 'Show me cart wjIuzcKhQkysJ80hQyatq and trace its lineage.', intent: 'Should go straight to trace_cartridge, not pre-call find_cartridges.' },
	{ id: 'S11.4', section: '11 — Tool selection / anti-overlap', question: 'How many carts today AND what runs aborted?', intent: 'Two tools, no double-calls. count_cartridges_by_status + list_recent_runs.' },

	// === Section 12 — New tools from the autonomous build (Phases 1-4) ===
	{ id: 'S12.1', section: '12 — Chemical inventory (Phase 2)', question: 'Where do we keep the methanol?', intent: 'lookup_chemical — should return location + owning org, surface dual-stocking note if both orgs have it.' },
	{ id: 'S12.2', section: '12 — Chemical inventory (Phase 2)', question: 'How much sodium azide do we have?', intent: 'lookup_chemical — BT regulated chemical; should surface hazard class.' },
	{ id: 'S12.3', section: '12 — Chemical inventory (Phase 2)', question: 'Find any flammable chemicals over 1 gallon.', intent: 'lookup_chemical with hazardClass filter — exercises the FLAM class + quantity reading.' },
	{ id: 'S12.4', section: '12 — Chemical inventory (Phase 2)', question: 'Tell me about chemical C-042.', intent: 'lookup_chemical by inventory code (C-NNN = Brevitest).' },
	{ id: 'S12.5', section: '12 — Chemical inventory (Phase 2)', question: 'Do we have DMSO in the lab?', intent: 'lookup_chemical — DMSO is on the dual-stocked list; must surface the "both orgs keep their own" warning.' },

	{ id: 'S12.6', section: '12 — Floor plan (Phase 3)', question: 'Where is Fridge 3?', intent: 'find_location — should return spatial description, not just a tag.' },
	{ id: 'S12.7', section: '12 — Floor plan (Phase 3)', question: "What's in the Tissue Culture zone?", intent: 'find_location with zone name — should list equipment + chemicals in that zone.' },
	{ id: 'S12.8', section: '12 — Floor plan (Phase 3)', question: 'Where are the OT-2 robots located?', intent: 'find_location with fuzzy equipment name — should resolve to Manufacturing zone.' },
	{ id: 'S12.9', section: '12 — Floor plan (Phase 3)', question: 'Which side of the lab is the cartridge oven on?', intent: 'find_location — natural-language spatial question.' }
];

const QUOTE_PREFIX = '> ';

function trunc(s: string, n: number): string {
	if (!s) return '';
	return s.length > n ? s.slice(0, n) + '…' : s;
}

function fmtAnswer(s: string): string {
	if (!s) return '_(empty)_';
	return s.split('\n').map((l) => QUOTE_PREFIX + l).join('\n');
}

async function main() {
	const args = process.argv.slice(2);
	let model: AskBimsModel = 'claude-haiku-4-5';
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--model') {
			const v = args[++i];
			if (v === 'haiku') model = 'claude-haiku-4-5';
			else if (v === 'sonnet') model = 'claude-sonnet-4-6';
			else if (v === 'opus') model = 'claude-opus-4-7';
		}
	}

	if (!process.env.ANTHROPIC_API_KEY) {
		console.error('ANTHROPIC_API_KEY not set');
		process.exit(1);
	}
	if (!process.env.MONGODB_URI) {
		console.error('MONGODB_URI not set');
		process.exit(1);
	}

	await mongoose.connect(process.env.MONGODB_URI);
	console.log(`✓ Mongo connected`);
	console.log(`✓ Model: ${model}`);
	console.log(`Running ${QUESTIONS.length} acceptance questions…\n`);

	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const outPath = path.resolve(process.cwd(), `docs/ask-bims-acceptance-answers-${stamp}.md`);

	const lines: string[] = [];
	lines.push(`# Ask BIMS — Acceptance Answer Sheet (${stamp})`);
	lines.push('');
	lines.push(`**Model:** ${model}`);
	lines.push(`**Total questions:** ${QUESTIONS.length}`);
	lines.push(`**Generated:** ${new Date().toUTCString()}`);
	lines.push('');
	lines.push('Each block below shows the **question**, what the test is **probing**, the **tools fired**, the **confidence** (derived from tool results — not the model\'s self-report), and the **answer** as returned by Ask BIMS. Grade each answer\'s factual accuracy — the agent\'s job is to be correct, cited, and to surface known data gaps. Hand the failures back to me and I\'ll diagnose.');
	lines.push('');
	lines.push('---');
	lines.push('');

	let totalCost = 0;
	let currentSection = '';

	for (let i = 0; i < QUESTIONS.length; i++) {
		const q = QUESTIONS[i];
		if (q.section !== currentSection) {
			lines.push('');
			lines.push(`## Section ${q.section}`);
			lines.push('');
			currentSection = q.section;
		}
		process.stdout.write(`  ${q.id} ${trunc(q.question, 60)}… `);
		const t0 = Date.now();
		try {
			const result = await askBims(
				[{ role: 'user', content: q.question }],
				{ model }
			);
			const durMs = Date.now() - t0;
			const cost = result.usage?.estCostUsd ?? 0;
			totalCost += cost;

			const toolNames = result.toolCalls.map((tc) => tc.name);
			const toolList = toolNames.length === 0 ? '_(none — answered from system prompt)_' : '`' + toolNames.join('`, `') + '`';

			lines.push(`### ${q.id}. ${q.question}`);
			lines.push('');
			lines.push(`**Probing:** ${q.intent}`);
			lines.push('');
			lines.push(`**Tools fired:** ${toolList}`);
			if (result.confidence) {
				const badge = result.confidence === 'high' ? '🟢' : result.confidence === 'partial' ? '🟡' : '🔴';
				lines.push(`**Confidence:** ${badge} ${result.confidence}` + (result.confidenceReasons && result.confidenceReasons.length > 0 ? ` _(${result.confidenceReasons.slice(0, 2).join('; ')})_` : ''));
			}
			lines.push(`**Cost:** $${cost.toFixed(4)} (${durMs}ms)`);
			lines.push('');
			lines.push(`**Answer:**`);
			lines.push('');
			lines.push(fmtAnswer(result.answer || result.error || '_(no answer)_'));
			lines.push('');
			lines.push('**Grade this answer:** ☐ Correct  ☐ Partially correct  ☐ Wrong  ☐ N/A');
			lines.push('');
			lines.push('---');
			lines.push('');

			process.stdout.write(`✓ $${cost.toFixed(4)} ${result.confidence ?? '?'}\n`);
		} catch (err: any) {
			lines.push(`### ${q.id}. ${q.question}`);
			lines.push('');
			lines.push(`**Probing:** ${q.intent}`);
			lines.push('');
			lines.push(`**Error:** \`${err?.message ?? String(err)}\``);
			lines.push('');
			lines.push('---');
			lines.push('');
			process.stdout.write(`✗ ${err?.message ?? err}\n`);
		}
	}

	lines.push('');
	lines.push(`## Summary`);
	lines.push('');
	lines.push(`- **Total questions run:** ${QUESTIONS.length}`);
	lines.push(`- **Model:** ${model}`);
	lines.push(`- **Total cost:** $${totalCost.toFixed(4)}`);
	lines.push('');

	fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
	console.log(`\n✓ Wrote ${outPath}`);
	console.log(`  Total cost: $${totalCost.toFixed(4)}`);

	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
