/**
 * Test runner for Ask BIMS baseline questions.
 *
 * For each question, calls askBims() directly (server-side; bypasses /api), then
 * asserts on:
 *   - requiredTools: every name in this list must appear in result.toolCalls
 *   - forbiddenTools: none of these names may appear (anti-overlap, redirection)
 *   - expectedAnswerPhrases: each regex must match the answer text
 *   - callCounts: optional — for anti-redundancy, a tool may need to appear EXACTLY once
 *
 * Tracks total spend across the suite so we can guard against runaway costs.
 */

import { askBims, type AskBimsModel } from '../../src/lib/server/ask-bims.js';
import type { TestQuestion } from './baseline.js';

export interface TestResult {
	id: string;
	category: string;
	passed: boolean;
	failures: string[];
	toolsCalled: string[];
	toolCallCount: number;
	answer: string;
	costUsd: number;
	durationMs: number;
}

export async function runQuestion(q: TestQuestion, model: AskBimsModel): Promise<TestResult> {
	const t0 = Date.now();
	const result = await askBims([{ role: 'user', content: q.text }], { model });
	const durationMs = Date.now() - t0;

	const failures: string[] = [];
	const toolsCalled = result.toolCalls.map(tc => tc.name);

	// Required tools
	for (const required of q.requiredTools) {
		if (!toolsCalled.includes(required)) {
			failures.push(`Missing required tool: ${required}`);
		}
	}

	// Forbidden tools
	for (const forbidden of q.forbiddenTools ?? []) {
		if (toolsCalled.includes(forbidden)) {
			failures.push(`Forbidden tool was called: ${forbidden}`);
		}
	}

	// Anti-redundancy: any tool called > 1 time in the same turn fails the
	// system-prompt rule G ("never re-call the same tool in one turn").
	const callCounts: Record<string, number> = {};
	for (const t of toolsCalled) callCounts[t] = (callCounts[t] ?? 0) + 1;
	for (const [name, count] of Object.entries(callCounts)) {
		if (count > 1) failures.push(`Tool ${name} was called ${count}× in one turn (anti-redundancy violation)`);
	}

	// Answer phrases
	for (const re of q.expectedAnswerPhrases ?? []) {
		if (!re.test(result.answer)) {
			failures.push(`Answer missing pattern: ${re}`);
		}
	}

	// Server-side errors are counted as failures
	if (result.error) {
		failures.push(`Server error: ${result.error}`);
	}

	return {
		id: q.id,
		category: q.category,
		passed: failures.length === 0,
		failures,
		toolsCalled,
		toolCallCount: toolsCalled.length,
		answer: result.answer,
		costUsd: result.usage?.estCostUsd ?? 0,
		durationMs
	};
}

export async function runSuite(
	questions: TestQuestion[],
	opts: { model?: AskBimsModel; maxCostUsd?: number } = {}
): Promise<{ results: TestResult[]; passed: number; failed: number; totalCostUsd: number; halted: boolean }> {
	const model = opts.model ?? 'claude-sonnet-4-6';
	const maxCost = opts.maxCostUsd ?? 2;
	const results: TestResult[] = [];
	let totalCost = 0;
	let halted = false;

	for (const q of questions) {
		if (totalCost >= maxCost) {
			console.warn(`\n⚠ Cost ceiling reached ($${totalCost.toFixed(4)} >= $${maxCost}). Halting before ${q.id}.`);
			halted = true;
			break;
		}
		process.stdout.write(`  [${q.category}] ${q.id}…`);
		try {
			const r = await runQuestion(q, model);
			totalCost += r.costUsd;
			results.push(r);
			if (r.passed) {
				process.stdout.write(` ✓ ($${r.costUsd.toFixed(4)})\n`);
			} else {
				process.stdout.write(` ✗\n`);
				for (const f of r.failures) console.log(`      - ${f}`);
				console.log(`      tools=[${r.toolsCalled.join(', ')}]`);
				// Show the actual answer so we can tell whether the failure is a real
				// regression or an over-strict assertion. Truncate to avoid spam.
				const snippet = r.answer.length > 300 ? r.answer.slice(0, 300) + '…' : r.answer;
				console.log(`      answer="${snippet.replace(/\n/g, ' ')}"`);
			}
		} catch (err: any) {
			results.push({
				id: q.id,
				category: q.category,
				passed: false,
				failures: [`Threw: ${err?.message ?? String(err)}`],
				toolsCalled: [],
				toolCallCount: 0,
				answer: '',
				costUsd: 0,
				durationMs: 0
			});
			process.stdout.write(' ✗ (threw)\n');
			console.log(`      ${err?.message ?? err}`);
		}
	}

	const passed = results.filter(r => r.passed).length;
	const failed = results.length - passed;
	return { results, passed, failed, totalCostUsd: totalCost, halted };
}
