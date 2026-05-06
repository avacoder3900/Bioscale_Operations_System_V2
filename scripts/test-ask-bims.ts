/**
 * Entry point for the Ask BIMS test harness.
 *
 * Usage:
 *   npx tsx scripts/test-ask-bims.ts                      # Sonnet, all categories, $2 cap
 *   npx tsx scripts/test-ask-bims.ts --model haiku        # cheaper iteration
 *   npx tsx scripts/test-ask-bims.ts --category wax       # one category
 *   npx tsx scripts/test-ask-bims.ts --max-cost 0.5       # tighter cap
 *
 * Connects to Mongo (read-only — askBims tools query, never write), runs the
 * baseline question suite, prints pass/fail per question, exits 0 on full pass
 * or 1 on any failure.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { BASELINE_QUESTIONS, questionsByCategory } from '../tests/ask-bims/baseline.js';
import { runSuite } from '../tests/ask-bims/runner.js';
import type { AskBimsModel } from '../src/lib/server/ask-bims.js';

dotenv.config();

function parseArgs() {
	const args = process.argv.slice(2);
	const out: { model: AskBimsModel; category?: string; maxCost: number } = {
		model: 'claude-sonnet-4-6',
		maxCost: 2
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--model') {
			const v = args[++i];
			if (v === 'haiku') out.model = 'claude-haiku-4-5';
			else if (v === 'sonnet') out.model = 'claude-sonnet-4-6';
			else if (v === 'opus') out.model = 'claude-opus-4-7';
			else if (v === 'claude-haiku-4-5' || v === 'claude-sonnet-4-6' || v === 'claude-opus-4-7') {
				out.model = v as AskBimsModel;
			}
		} else if (a === '--category') {
			out.category = args[++i];
		} else if (a === '--max-cost') {
			out.maxCost = Number(args[++i]);
		}
	}
	return out;
}

async function main() {
	const { model, category, maxCost } = parseArgs();

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
	console.log(`✓ Cost ceiling: $${maxCost}\n`);

	let questions = BASELINE_QUESTIONS;
	if (category) {
		const grouped = questionsByCategory();
		questions = grouped[category];
		if (!questions) {
			console.error(`Unknown category "${category}". Known: ${Object.keys(grouped).join(', ')}`);
			process.exit(1);
		}
		console.log(`Filtered to category "${category}": ${questions.length} question(s)\n`);
	}

	console.log(`Running ${questions.length} question(s)…\n`);
	const summary = await runSuite(questions, { model, maxCostUsd: maxCost });

	console.log(`\n${'='.repeat(60)}`);
	console.log(`Summary: ${summary.passed}/${summary.results.length} passed, ${summary.failed} failed`);
	console.log(`Total cost: $${summary.totalCostUsd.toFixed(4)}`);
	if (summary.halted) console.log(`⚠ HALTED — cost ceiling reached`);

	// Per-category breakdown
	const byCategory: Record<string, { p: number; f: number; cost: number }> = {};
	for (const r of summary.results) {
		const c = byCategory[r.category] ?? { p: 0, f: 0, cost: 0 };
		if (r.passed) c.p++; else c.f++;
		c.cost += r.costUsd;
		byCategory[r.category] = c;
	}
	console.log('\nBy category:');
	for (const [cat, { p, f, cost }] of Object.entries(byCategory)) {
		console.log(`  ${cat.padEnd(15)} ${p}p / ${f}f  ($${cost.toFixed(4)})`);
	}

	if (summary.failed > 0) {
		console.log('\nFailed questions:');
		for (const r of summary.results.filter(x => !x.passed)) {
			console.log(`  - ${r.id}: ${r.failures.join('; ')}`);
		}
	}

	await mongoose.disconnect();
	process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
