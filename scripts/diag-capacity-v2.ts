/** KB2-31 acceptance smoke — read-only against live Atlas. */
import * as dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { computeRoadmap } from '../src/lib/server/kanban/schedule';

async function main() {
	// #5 legacy: knob is null in prod → numbers must match pre-KB2-31 behavior.
	const legacy = await computeRoadmap();
	console.log('LEGACY (knob null):');
	console.log('  velocity:', legacy.velocityDaysPerWeek, ' measured:', legacy.measuredVelocityDaysPerWeek, ' source:', legacy.velocitySource, ' n:', legacy.velocitySampleN);
	for (const m of legacy.milestones)
		console.log(`  [${m.title}] cpm=${m.cpmFinish} clamp=${m.clampFinish} projected=${m.projectedFinish} buffer=${m.bufferDays} feasible=${m.feasible} remaining=${m.remainingDays}`);

	// #1 what-if: capacityOverride 10 → A4M should land ~mid-November 2026.
	const ten = await computeRoadmap(new Date(), { capacityOverride: 10 });
	console.log('\nWHAT-IF capacityOverride=10:');
	console.log('  velocity:', ten.velocityDaysPerWeek, ' source:', ten.velocitySource, ' schedule:', JSON.stringify(ten.resolvedCapacitySchedule));
	for (const m of ten.milestones)
		console.log(`  [${m.title}] clamp=${m.clampFinish} projected=${m.projectedFinish} buffer=${m.bufferDays} feasible=${m.feasible}`);

	// #3 schedule what-if: 10 now, 15 from Oct 1 → should improve vs flat 10.
	const sched = await computeRoadmap(new Date(), {
		capacityOverride: 10,
		scheduleOverride: [{ from: '2026-10-01', teamEstDaysPerWeek: 15 }]
	});
	console.log('\nWHAT-IF 10 now + 15 from Oct 1:');
	console.log('  schedule:', JSON.stringify(sched.resolvedCapacitySchedule));
	for (const m of sched.milestones)
		console.log(`  [${m.title}] clamp=${m.clampFinish} projected=${m.projectedFinish} buffer=${m.bufferDays} feasible=${m.feasible}`);

	// #6 re-call without overrides matches legacy
	const legacy2 = await computeRoadmap();
	const same = JSON.stringify(legacy.milestones.map((m) => m.projectedFinish)) === JSON.stringify(legacy2.milestones.map((m) => m.projectedFinish));
	console.log('\nRe-call without overrides matches:', same);
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
