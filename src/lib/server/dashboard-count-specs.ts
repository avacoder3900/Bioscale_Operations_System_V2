import { WAX_STAGE_STATUSES } from '$lib/shared/cartridge-wax-status';
import { countBy, countSpec, type GroupSpec } from './checked-out-counts';

/**
 * The cartridge_records counts behind the home page (`/`) and `/cartridge-dashboard`,
 * run through groupCountsExcluding(). Kept in one place so
 * scripts/verify-dashboard-counts.ts checks exactly what the pages run.
 */

const windowStart = (now: Date) => new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

const shared = (now: Date) => ({
	phaseCounts: countBy({ status: { $ne: null } }, 'status', { count: -1 }),
	totalMfg: countSpec({ status: { $ne: 'voided' } }),
	totalVoided: countSpec({ status: 'voided' }),
	waxQc: countBy({ 'waxQc.status': { $exists: true } }, 'waxQc.status'),
	reagentInspection: countBy({ 'reagentInspection.status': { $exists: true } }, 'reagentInspection.status'),
	weeklyProduction: countSpec({ createdAt: { $gte: windowStart(now) } }),
	assayBreakdown: countBy({ 'reagentFilling.assayType.name': { $exists: true } }, 'reagentFilling.assayType.name', { count: -1 }),
	waxStageByLocation: countBy({ status: { $in: [...WAX_STAGE_STATUSES] }, 'waxStorage.location': { $exists: true } }, 'waxStorage.location'),
	scrappedByLocation: countBy({ status: 'scrapped', 'waxStorage.location': { $exists: true } }, 'waxStorage.location')
});

export const homeCountSpecs = (now: Date) => ({
	...shared(now),
	storedByFridge: countBy({ status: 'stored', 'storage.fridgeName': { $exists: true } }, 'storage.fridgeName'),
	assayFills: countBy({ 'reagentFilling.assayType._id': { $exists: true } }, 'reagentFilling.assayType._id'),
	dailyThroughput: {
		match: { createdAt: { $gte: windowStart(now) } },
		group: {
			_id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
			count: { $sum: 1 },
			passed: { $sum: { $cond: [{ $eq: ['$qcStatus', 'passed'] }, 1, 0] } },
			failed: { $sum: { $cond: [{ $eq: ['$qcStatus', 'failed'] }, 1, 0] } },
			pending: { $sum: { $cond: [{ $in: ['$qcStatus', ['pending', null]] }, 1, 0] } }
		},
		sort: { _id: 1 }
	} satisfies GroupSpec
});

export const dashboardCountSpecs = (now: Date) => ({
	...shared(now),
	reagentByFridge: countBy({ status: { $in: ['stored', 'reagent_filled'] }, 'storage.fridgeName': { $exists: true } }, 'storage.fridgeName'),
	backingByOven: countBy({ status: 'backing' }, 'backing.ovenLocationId')
});
