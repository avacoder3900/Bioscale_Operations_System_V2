// One-shot rewriter for the cart-mfg URL restructure.
// Renames /manufacturing/<step> -> /manufacturing/cart-mfg/<step> across the
// repo, anchored to a leading quote so it cannot touch import paths like
// $lib/components/manufacturing/<step>/...
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const STEPS = [
	'cut-thermoseal', 'laser-cutting',
	'wi-01', 'wi-02', 'wi-03',
	'wax-creation', 'wax-filling', 'reagent-filling',
	'opentron-control', 'qa-qc', 'top-seal-cutting',
	'opentrons', 'robot-arm', 'scrap',
	'analysis', 'lots', 'pipeline'
];

const QUOTES = ["'", '"', '`'];

const files = execSync('git ls-files src', { encoding: 'utf8' })
	.split('\n')
	.map(s => s.trim())
	.filter(Boolean)
	.filter(f => /\.(svelte|ts|js|mjs)$/.test(f));

let touched = 0;
for (const file of files) {
	let content = readFileSync(file, 'utf8');
	const original = content;
	for (const step of STEPS) {
		for (const q of QUOTES) {
			const oldStr = `${q}/manufacturing/${step}`;
			const newStr = `${q}/manufacturing/cart-mfg/${step}`;
			content = content.split(oldStr).join(newStr);
		}
	}
	if (content !== original) {
		writeFileSync(file, content, 'utf8');
		touched++;
		console.log('UPDATED', file);
	}
}
console.log(`\nTotal files updated: ${touched}`);
