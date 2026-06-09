/**
 * Comprehensive model comparison: 13 prompts × 3 models = 39 runs.
 *
 * Spans inventory/supplier, metrics/trends, cartridge history, and meta/system
 * questions. Tests not just tool selection but also: anti-guessing rule (does
 * the model say "I can't" when no tool fits?), integrity warning surfacing,
 * answer quality across complexity.
 *
 * Cost cap: $3.50 (under user's $4 budget).
 * Output: stdout summary + tests/ask-bims/comprehensive-results.json for later analysis.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import { askBims, type AskBimsModel } from '../src/lib/server/ask-bims.js';

dotenv.config();

interface Prompt {
	id: string;
	domain: 'inventory' | 'metrics' | 'cartridge-history' | 'meta';
	complexity: 'simple' | 'medium' | 'complex';
	text: string;
	tests: string;
	noToolExpected?: boolean; // if true, answering without calling any tool is acceptable / expected
}

const PROMPTS: Prompt[] = [
	// === INVENTORY + SUPPLIER ===
	{
		id: 'inv-supplier-most-active',
		domain: 'inventory',
		complexity: 'medium',
		text: 'Which supplier do we receive the most parts from, and what parts do they provide?',
		tests: 'Aggregation across PartDefinition.supplier — needs find_part or list_low_inventory_parts; tests if model gives up gracefully if no tool aggregates by supplier.'
	},
	{
		id: 'inv-recent-lot',
		domain: 'inventory',
		complexity: 'medium',
		text: 'Show me the most recently inducted receiving lot — what part is it, what status, and was it used in any manufacturing runs yet?',
		tests: 'No direct tool for "most recent receiving lot." Model should either say so or chain find_part/find_receiving_lot creatively.'
	},
	{
		id: 'inv-wax-stock-and-location',
		domain: 'inventory',
		complexity: 'simple',
		text: 'How much PT-CT-114 wax tube inventory do we have, and where is it stored?',
		tests: 'get_wax_tube_inventory + maybe list_equipment for location context.'
	},
	{
		id: 'inv-failed-inspections',
		domain: 'inventory',
		complexity: 'medium',
		text: 'Are there any receiving lots that have failed inspection or had QC issues recently?',
		tests: 'No direct tool for receiving inspections (Phase 2 deferred list_receiving_inspections). Model should say it doesn\'t have that tool.'
	},

	// === METRICS + TRENDS ===
	{
		id: 'metric-yield-trend',
		domain: 'metrics',
		complexity: 'complex',
		text: 'What\'s our wax filling yield trend over the last 14 days? Is it improving or declining?',
		tests: 'production_throughput should give the data. Tests trend reasoning over real numbers.'
	},
	{
		id: 'metric-throughput-week-comparison',
		domain: 'metrics',
		complexity: 'complex',
		text: 'Compare our cartridge production this week vs last week.',
		tests: 'Two windows of production_throughput, compared. Model should call ONCE with sinceDays>=14 and split internally, NOT call twice.'
	},
	{
		id: 'metric-noisy-equipment',
		domain: 'metrics',
		complexity: 'medium',
		text: 'Which fridges or ovens have had the most temperature alerts in the last 7 days?',
		tests: 'get_temperature_alerts with sinceHours=168 — model should aggregate by sensor in the answer.'
	},
	{
		id: 'metric-burn-rate-projection',
		domain: 'metrics',
		complexity: 'medium',
		text: 'How fast are we using PT-CT-104, and how long until we run out at current rates?',
		tests: 'inventory_burn_rate or runway. Single tool, projection answer.'
	},

	// === CARTRIDGE HISTORY ===
	{
		id: 'history-recall-impact',
		domain: 'cartridge-history',
		complexity: 'complex',
		text: 'If we had to recall receiving lot 74b942a2-16a5-4ae4-aa91-917d3ecc146a, which cartridges would be affected?',
		tests: 'forward_genealogy is the right tool. Tests UUID handling + forward-trace.'
	},
	{
		id: 'history-operator-today',
		domain: 'cartridge-history',
		complexity: 'medium',
		text: 'What cartridges has operator Nick worked on today, and what\'s their current status?',
		tests: 'No direct tool for operator filter. Model should chain list_recent_runs (Nick filter not available) + find_cartridges, or say it can\'t filter by operator.'
	},
	{
		id: 'history-scrapped-trace',
		domain: 'cartridge-history',
		complexity: 'complex',
		text: 'Find a cartridge that was scrapped recently and tell me what went wrong and what lots were involved.',
		tests: 'find_cartridges(status=scrapped) + trace_cartridge or backward_genealogy. Tests anti-double-call.'
	},

	// === META + SYSTEM ===
	{
		id: 'meta-temperature-source',
		domain: 'meta',
		complexity: 'simple',
		text: 'How does Ask BIMS get its information about temperatures? What database collections are involved?',
		tests: 'Pure meta — no tool answers this. Model should explain from system-prompt knowledge: TemperatureReading + TemperatureAlert + Equipment.currentTemperatureC.',
		noToolExpected: true
	},
	{
		id: 'meta-cartridge-lifecycle',
		domain: 'meta',
		complexity: 'simple',
		text: 'Explain what "wax_stored" status means in our cartridge lifecycle and what\'s supposed to happen next.',
		tests: 'Pure meta — should explain conceptually. Calling a tool would be over-fetching.',
		noToolExpected: true
	}
];

const MODELS: AskBimsModel[] = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];
const COST_CEILING = 3.50;

interface RunResult {
	promptId: string;
	domain: string;
	complexity: string;
	model: AskBimsModel;
	answer: string;
	toolCalls: string[];
	uniqueToolCount: number;
	totalToolCalls: number;
	hasRedundancy: boolean;
	hasIntegrityNote: boolean;
	answeredWithoutTools: boolean;
	costUsd: number;
	durationMs: number;
	error?: string;
	noToolExpected: boolean;
}

async function runOne(prompt: Prompt, model: AskBimsModel): Promise<RunResult> {
	const t0 = Date.now();
	const result = await askBims([{ role: 'user', content: prompt.text }], { model });
	const durationMs = Date.now() - t0;

	const toolCalls = result.toolCalls.map(tc => tc.name);
	const callCounts: Record<string, number> = {};
	for (const t of toolCalls) callCounts[t] = (callCounts[t] ?? 0) + 1;
	const hasRedundancy = Object.values(callCounts).some(c => c > 1);
	const hasIntegrityNote = result.toolCalls.some(tc =>
		Array.isArray((tc.result as any)?.dataIntegrityNotes) &&
		(tc.result as any).dataIntegrityNotes.length > 0
	);

	return {
		promptId: prompt.id,
		domain: prompt.domain,
		complexity: prompt.complexity,
		model,
		answer: result.answer,
		toolCalls,
		uniqueToolCount: new Set(toolCalls).size,
		totalToolCalls: toolCalls.length,
		hasRedundancy,
		hasIntegrityNote,
		answeredWithoutTools: toolCalls.length === 0,
		costUsd: result.usage?.estCostUsd ?? 0,
		durationMs,
		error: result.error,
		noToolExpected: !!prompt.noToolExpected
	};
}

function shortAnswer(s: string, max = 240): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length <= max ? t : t.slice(0, max) + '…';
}

async function main() {
	if (!process.env.ANTHROPIC_API_KEY || !process.env.MONGODB_URI) {
		console.error('Missing env'); process.exit(1);
	}
	await mongoose.connect(process.env.MONGODB_URI);
	console.log('✓ Mongo connected. Cost ceiling: $' + COST_CEILING);
	console.log(`Running ${PROMPTS.length} prompts × ${MODELS.length} models = ${PROMPTS.length * MODELS.length} runs.\n`);

	const results: RunResult[] = [];
	let totalCost = 0;
	let halted = false;

	for (const prompt of PROMPTS) {
		console.log(`\n━━━ [${prompt.domain}/${prompt.complexity}] ${prompt.id}`);
		console.log(`Q: "${prompt.text}"`);

		for (const model of MODELS) {
			if (totalCost >= COST_CEILING) {
				console.log(`\n⚠ COST CEILING REACHED ($${totalCost.toFixed(4)}). Halting.`);
				halted = true;
				break;
			}
			process.stdout.write(`  ${model.padEnd(22)}… `);
			try {
				const r = await runOne(prompt, model);
				results.push(r);
				totalCost += r.costUsd;
				const flags = [
					r.hasRedundancy ? 'redundant' : '',
					r.hasIntegrityNote ? 'integrity!' : '',
					r.answeredWithoutTools ? 'no-tools' : '',
					r.error ? `err:${r.error.slice(0, 30)}` : ''
				].filter(Boolean).join(' ');
				const dur = (r.durationMs / 1000).toFixed(1);
				process.stdout.write(`${r.totalToolCalls} tools  $${r.costUsd.toFixed(4)}  ${dur}s  ${flags || 'ok'}\n`);
			} catch (err: any) {
				console.log(`✗ threw: ${err?.message ?? err}`);
			}
		}
		if (halted) break;
	}

	// Save raw results for later analysis
	const outPath = 'tests/ask-bims/comprehensive-results.json';
	fs.writeFileSync(outPath, JSON.stringify({
		runAt: new Date().toISOString(),
		totalCost,
		halted,
		results
	}, null, 2));
	console.log(`\n✓ Raw results: ${outPath}`);

	// Summary by model
	console.log('\n' + '═'.repeat(80));
	console.log('  SUMMARY BY MODEL');
	console.log('═'.repeat(80));
	for (const m of MODELS) {
		const rs = results.filter(r => r.model === m);
		const cost = rs.reduce((s, r) => s + r.costUsd, 0);
		const tools = rs.reduce((s, r) => s + r.totalToolCalls, 0);
		const redundancy = rs.filter(r => r.hasRedundancy).length;
		const errors = rs.filter(r => r.error).length;
		const noTool = rs.filter(r => r.answeredWithoutTools).length;
		const integrityHits = rs.filter(r => r.hasIntegrityNote).length;
		const avgDur = rs.length ? rs.reduce((s, r) => s + r.durationMs, 0) / rs.length / 1000 : 0;
		console.log(`\n${m}`);
		console.log(`  Total cost      : $${cost.toFixed(4)}`);
		console.log(`  Avg cost/q      : $${(cost / Math.max(rs.length, 1)).toFixed(4)}`);
		console.log(`  Avg latency     : ${avgDur.toFixed(1)}s`);
		console.log(`  Total tool calls: ${tools}`);
		console.log(`  Redundant calls : ${redundancy}/${rs.length}`);
		console.log(`  No-tool answers : ${noTool}/${rs.length}`);
		console.log(`  Integrity fires : ${integrityHits}/${rs.length}`);
		console.log(`  Errors          : ${errors}/${rs.length}`);
	}

	// Per-prompt comparison
	console.log('\n' + '═'.repeat(80));
	console.log('  PER-PROMPT COMPARISON');
	console.log('═'.repeat(80));
	for (const prompt of PROMPTS) {
		const byModel = MODELS.map(m => results.find(r => r.promptId === prompt.id && r.model === m)).filter(Boolean) as RunResult[];
		if (byModel.length === 0) continue;
		console.log(`\n[${prompt.complexity}] ${prompt.id}`);
		console.log(`  Q: ${prompt.text}`);
		for (const r of byModel) {
			const flags = [
				r.hasRedundancy ? '⚠redundant' : '',
				r.hasIntegrityNote ? '⚠integrity' : '',
				r.answeredWithoutTools && r.noToolExpected ? '✓no-tool-correct' : (r.answeredWithoutTools ? '⚠no-tool-unexpected' : '')
			].filter(Boolean).join(' ');
			console.log(`  ${r.model.padEnd(22)} ${r.totalToolCalls} tools  $${r.costUsd.toFixed(4)}  ${flags}`);
		}
		console.log(`  ── Haiku: ${shortAnswer(byModel.find(r => r.model === 'claude-haiku-4-5')?.answer ?? '')}`);
		console.log(`  ── Sonnet: ${shortAnswer(byModel.find(r => r.model === 'claude-sonnet-4-6')?.answer ?? '')}`);
		console.log(`  ── Opus: ${shortAnswer(byModel.find(r => r.model === 'claude-opus-4-7')?.answer ?? '')}`);
	}

	console.log(`\n\n=== TOTAL SPEND: $${totalCost.toFixed(4)} ===`);
	await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
