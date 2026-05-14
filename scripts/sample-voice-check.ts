/**
 * Quick voice-check: runs 6 questions known to have produced robot-speak in
 * previous answer sheets, and prints the new answers so we can eyeball the
 * tone shift after the VOICE & PHRASING section was added to the system prompt.
 *
 * Run: npx tsx scripts/sample-voice-check.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { askBims } from '../src/lib/server/ask-bims.js';

dotenv.config();

const QUESTIONS = [
	'What does the manufacturing flow audit say about laser cutting?',
	'How much wax do we have in stock right now?',
	'Any in-house wax production records?',
	'Trace the reagent chain for cartridge wjIuzcKhQkysJ80hQyatq.',
	'Show me the Active Beads v3 protocol details.',
	'How is data integrity looking across the system?'
];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	console.log('✓ Connected. Running voice check on 6 questions...\n');

	let totalCost = 0;
	for (let i = 0; i < QUESTIONS.length; i++) {
		const q = QUESTIONS[i];
		console.log('━'.repeat(80));
		console.log(`Q${i + 1}: ${q}`);
		console.log('━'.repeat(80));
		const r = await askBims([{ role: 'user', content: q }], { model: 'claude-haiku-4-5' });
		totalCost += r.usage?.estCostUsd ?? 0;
		console.log(`tools fired: ${r.toolCalls.map((tc) => tc.name).join(', ') || '(none)'}`);
		console.log(`confidence: ${r.confidence ?? '?'}`);
		console.log('answer:');
		console.log(r.answer || r.error || '(empty)');
		console.log('');
	}

	console.log('━'.repeat(80));
	console.log(`Total cost: $${totalCost.toFixed(4)}`);
	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
