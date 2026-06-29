import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// Cartridge data view — the "analyze" / view-the-data pathway ported from the
// research app. The cartridge_records `_id` IS the scanned barcode, so the
// barcode in the optical log links straight here.
export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const cartridge = await CartridgeRecord.findById(params.id).lean();
	if (!cartridge) {
		throw error(404, `Cartridge ${params.id} not found`);
	}

	return {
		barcode: params.id,
		metrics: computeMetrics(cartridge),
		cartridge: JSON.parse(JSON.stringify(cartridge))
	};
};

interface Group {
	key: string;
	n: number;
	f3Sum: number;
	f7Sum: number;
	ratio: number | null;
}
interface Metrics {
	readingCount: number;
	f3Sum: number | null;
	f7Sum: number | null;
	ratio: number | null;
	baselineScans: number | null;
	testScans: number | null;
	// Diagnostic groupings to find which subset of readings the research Excel
	// sums F3 over. Temporary — once the right cut is known this collapses to one.
	byChannel: Group[];
	byPosition: Group[];
	baselineVsTest: Group[];
}

function sumGroup(readings: any[], key: string): Group {
	let f3Sum = 0;
	let f7Sum = 0;
	for (const r of readings) {
		if (typeof r?.f3 === 'number') f3Sum += r.f3;
		if (typeof r?.f7 === 'number') f7Sum += r.f7;
	}
	return { key, n: readings.length, f3Sum, f7Sum, ratio: f3Sum !== 0 ? f7Sum / f3Sum : null };
}

function groupBy(readings: any[], field: string): Group[] {
	const buckets = new Map<string, any[]>();
	for (const r of readings) {
		const k = r?.[field] === undefined || r?.[field] === null ? '(none)' : String(r[field]);
		if (!buckets.has(k)) buckets.set(k, []);
		buckets.get(k)!.push(r);
	}
	return [...buckets.entries()]
		.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
		.map(([k, rs]) => sumGroup(rs, `${field}=${k}`));
}

// The "analyze" computation from the research workflow: sum the F3 and F7
// fluorometer channels, then the F7/F3 ratio. Returns null counts when there's
// no run data so the view can show an empty state. Also emits diagnostic
// groupings so we can identify which subset of readings the F3 sum should use.
function computeMetrics(cartridge: any): Metrics {
	const readings: any[] = Array.isArray(cartridge?.rawData?.readings)
		? cartridge.rawData.readings
		: [];

	const empty: Metrics = {
		readingCount: 0, f3Sum: null, f7Sum: null, ratio: null,
		baselineScans: null, testScans: null, byChannel: [], byPosition: [], baselineVsTest: []
	};
	if (readings.length === 0) return empty;

	const total = sumGroup(readings, 'all');

	// Baseline-vs-test split: the first `baselineScans` readings are baseline, the
	// rest are the test scans the assay actually measures.
	const baselineScans = typeof cartridge?.rawData?.baselineScans === 'number'
		? cartridge.rawData.baselineScans : null;
	const testScans = typeof cartridge?.rawData?.testScans === 'number'
		? cartridge.rawData.testScans : null;
	const baselineVsTest: Group[] = [];
	if (baselineScans !== null && baselineScans > 0 && baselineScans < readings.length) {
		baselineVsTest.push(sumGroup(readings.slice(0, baselineScans), `baseline (first ${baselineScans})`));
		baselineVsTest.push(sumGroup(readings.slice(baselineScans), `test (remaining ${readings.length - baselineScans})`));
	}

	return {
		readingCount: readings.length,
		f3Sum: total.f3Sum,
		f7Sum: total.f7Sum,
		ratio: total.ratio,
		baselineScans,
		testScans,
		byChannel: groupBy(readings, 'channel'),
		byPosition: groupBy(readings, 'position'),
		baselineVsTest
	};
}
