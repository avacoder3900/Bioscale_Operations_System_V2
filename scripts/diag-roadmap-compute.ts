/** KB2-28 smoke test — read-only: run computeRoadmap against live data + unit-check day math. */
import * as dotenv from 'dotenv';
dotenv.config();
import { computeRoadmap, addBusinessDays, businessDaysBetween } from '../src/lib/server/kanban/schedule';
import mongoose from 'mongoose';

async function main() {
	// day-math unit checks
	const fri = new Date('2026-08-21'); // Friday
	console.log('add 1 bd to Fri →', addBusinessDays(fri, 1).toDateString(), '(want Mon Aug 24)');
	console.log('add -3 bd to Fri →', addBusinessDays(fri, -3).toDateString(), '(want Tue Aug 18)');
	console.log('bd between Aug 21 → Aug 24:', businessDaysBetween(fri, new Date('2026-08-24')), '(want 1)');
	console.log('bd between Aug 24 → Aug 21:', businessDaysBetween(new Date('2026-08-24'), fri), '(want -1)');

	const r = await computeRoadmap();
	console.log('\nmilestones:', r.milestones.length, ' unscheduled:', r.unscheduledMilestones.length);
	console.log('velocityDaysPerWeek:', r.velocityDaysPerWeek, ' medianCycleDays:', r.medianCycleDays);
	console.log('calibration:', r.calibration);
	for (const m of r.milestones) {
		console.log(`\n[${m.title}] due=${m.dueDate} daysLeft=${m.daysLeft} projected=${m.projectedFinish} buffer=${m.bufferDays} feasible=${m.feasible} tasks=${m.tasks.length} mustStart=${m.mustStart.length}${m.cycleError ? ' CYCLE: ' + m.cycleError : ''}`);
		for (const t of m.mustStart.slice(0, 5)) console.log(`   MUST-START ${t.late ? 'LATE' : ''} slack=${t.slackDays} ls=${t.lateStart} ${t.trackingNumber ?? t.id} ${t.title}`);
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
