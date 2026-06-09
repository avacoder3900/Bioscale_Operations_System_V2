/**
 * Does the demo data make physical/logical sense?
 * Cartridges should flow monotonically through the pipeline:
 *   WI-01 backed → Wax filled → Reagent filled → Top sealed → QA/QC released
 * Each stage's input should ≤ upstream stage's accepted output.
 *
 * Also checks: Pareto reject sum vs run-level reject sum, yield math, etc.
 */
import { getDemoAnalyticsPageData } from '../src/lib/server/analytics/demo-seed.js';

const d = getDemoAnalyticsPageData();

// Group runs by process
const byProc = new Map<string, any[]>();
for (const r of d.runs) {
	const arr = byProc.get(r.processType) ?? [];
	arr.push(r);
	byProc.set(r.processType, arr);
}

const order = ['laser-cut', 'cut-thermoseal', 'cut-top-seal', 'wi-01', 'wax', 'reagent', 'top-seal', 'qa-qc'];

console.log('=== Per-process totals ===');
console.log('process         | runs | actual | accepted | rejected | scrap | avg-batch');
console.log('---------------------------------------------------------------------');
for (const p of order) {
	const runs = byProc.get(p) ?? [];
	const actual = runs.reduce((s, r) => s + (r.actualCount ?? 0), 0);
	const accepted = runs.reduce((s, r) => s + (r.acceptedCount ?? 0), 0);
	const rejected = runs.reduce((s, r) => s + (r.rejectedCount ?? 0), 0);
	const scrap = runs.reduce((s, r) => s + (r.scrapCount ?? 0), 0);
	const avgBatch = runs.length > 0 ? actual / runs.length : 0;
	console.log(`${p.padEnd(15)} | ${String(runs.length).padStart(4)} | ${String(actual).padStart(6)} | ${String(accepted).padStart(8)} | ${String(rejected).padStart(8)} | ${String(scrap).padStart(5)} | ${avgBatch.toFixed(1)}`);
}

console.log('\n=== Flow check (cartridges consumed by downstream) ===');
const backedOut = (byProc.get('wi-01') ?? []).reduce((s, r) => s + (r.acceptedCount ?? 0), 0);
const waxIn = (byProc.get('wax') ?? []).reduce((s, r) => s + (r.actualCount ?? 0), 0);
const waxOut = (byProc.get('wax') ?? []).reduce((s, r) => s + (r.acceptedCount ?? 0), 0);
const reagentIn = (byProc.get('reagent') ?? []).reduce((s, r) => s + (r.actualCount ?? 0), 0);
const reagentOut = (byProc.get('reagent') ?? []).reduce((s, r) => s + (r.acceptedCount ?? 0), 0);
const topSealIn = (byProc.get('top-seal') ?? []).reduce((s, r) => s + (r.actualCount ?? 0), 0);
const topSealOut = (byProc.get('top-seal') ?? []).reduce((s, r) => s + (r.acceptedCount ?? 0), 0);
const qaIn = (byProc.get('qa-qc') ?? []).reduce((s, r) => s + (r.actualCount ?? 0), 0);
const qaOut = (byProc.get('qa-qc') ?? []).reduce((s, r) => s + (r.acceptedCount ?? 0), 0);

console.log(`  WI-01 out:     ${backedOut}`);
console.log(`  Wax in:        ${waxIn}  ${waxIn > backedOut ? '← OVER-CONSUMING by ' + (waxIn - backedOut) : 'OK'}`);
console.log(`  Wax out:       ${waxOut}`);
console.log(`  Reagent in:    ${reagentIn}  ${reagentIn > waxOut ? '← OVER-CONSUMING by ' + (reagentIn - waxOut) : 'OK'}`);
console.log(`  Reagent out:   ${reagentOut}`);
console.log(`  Top-seal in:   ${topSealIn}  ${topSealIn > reagentOut ? '← OVER-CONSUMING by ' + (topSealIn - reagentOut) : 'OK'}`);
console.log(`  Top-seal out:  ${topSealOut}`);
console.log(`  QA-QC in:      ${qaIn}  ${qaIn > topSealOut ? '← OVER-CONSUMING by ' + (qaIn - topSealOut) : 'OK'}`);
console.log(`  QA-QC out:     ${qaOut}`);

console.log('\n=== Supporting materials (sheets produced vs needed) ===');
const laserOut = (byProc.get('laser-cut') ?? []).reduce((s, r) => s + (r.actualCount ?? 0), 0);
const thermoOut = (byProc.get('cut-thermoseal') ?? []).reduce((s, r) => s + (r.actualCount ?? 0), 0);
const topSealSheetOut = (byProc.get('cut-top-seal') ?? []).reduce((s, r) => s + (r.actualCount ?? 0), 0);
console.log(`  Laser cut sheets produced:     ${laserOut}`);
console.log(`  Cut thermoseal sheets:         ${thermoOut}`);
console.log(`  WI-01 needs thermoseal (1:1):  ${backedOut}  ${(laserOut + thermoOut) < backedOut ? '← SHORT' : 'OK'}`);
console.log(`  Top seal sheets produced:      ${topSealSheetOut}`);
console.log(`  Top-seal app needs:            ${topSealIn}  ${topSealSheetOut < topSealIn ? '← SHORT' : 'OK'}`);

console.log('\n=== Pareto reject-sum vs run-level reject-sum ===');
const paretoSum = d.yieldFailures.pareto.reduce((s, p) => s + p.count, 0);
const runRejectSum = d.runs.reduce((s, r) => s + (r.rejectedCount ?? 0), 0);
const runAbortCount = d.runs.filter(r => r.abortReason).length;
console.log(`  Pareto total:                  ${paretoSum}`);
console.log(`  Sum of run.rejectedCount:      ${runRejectSum}`);
console.log(`  Sum of abort flags:            ${runAbortCount}`);
console.log(`  Expected Pareto ≈ rejects + aborts = ${runRejectSum + runAbortCount}  ${Math.abs(paretoSum - runRejectSum - runAbortCount) > 5 ? '← MISMATCH' : 'OK'}`);

console.log('\n=== Yield & RTY math ===');
console.log(`  Overall FPY: ${(d.overview.overallFpy * 100).toFixed(2)}%`);
console.log(`  RTY: ${(d.overview.rty * 100).toFixed(2)}%`);
console.log(`  Total runs: ${d.runs.length}`);
console.log(`  Total produced (accepted): ${d.overview.totalProduced}`);
console.log(`  Total inspected: ${d.overview.totalInspected}`);
console.log(`  Total rejected: ${d.overview.totalRejected}`);
console.log(`  Total scrapped: ${d.overview.totalScrapped}`);
