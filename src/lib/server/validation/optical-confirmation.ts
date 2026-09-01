// Optical-confirmation validation data, shared by the assign/log page and the
// validation-run detail page.
//
// There is no join table between a ValidationRun and the optical cartridges an
// SPU ran: the device writes a `device` block onto cartridge_records, and its
// `name` IS the SPU's UDI. So an SPU's optical results are recovered by
// matching device.name to the member UDI and keeping only the cartridges that
// belong to this run (assigned or completed at/after the SPU joined it).
import { CartridgeRecord } from '../db/models/index.js';
import { computeOpticalAnalysis } from '../optical-analysis.js';

// The single optical-confirmation assay in use: "Gen 5 Optical Scan - Start
// Position Corrected". Change this id if a different optical assay is adopted.
export const OPTICAL_ASSAY_ID = 'A9EB41AD';

// Select by ASSAY, not assayCategory: most Gen 5 runs are created through paths
// that never set a category, so a category filter hides nearly the whole set.
export const OPTICAL_CARTRIDGE_FILTER = {
	$or: [
		{ assayId: OPTICAL_ASSAY_ID },
		{ 'assay._id': OPTICAL_ASSAY_ID },
		{ assayName: /Gen 5 Optical/i }
	]
};

export interface OpticalCartridgeSummary {
	barcode: string;
	serialNumber: string | null;
	status: string;
	assignedAt: string | null;
	ranAt: string | null;
	readingCount: number;
	scanGroup: string;
	ratioByChannel: Record<string, number | null>;
}

export interface SpuOpticalSummary {
	cartridges: OpticalCartridgeSummary[];
	// Union of channels seen across this SPU's cartridges, sorted (A, B, C).
	channels: string[];
	meanByChannel: Record<string, number | null>;
	latestRanAt: string | null;
}

function iso(d: unknown): string | null {
	if (!d) return null;
	const date = d instanceof Date ? d : new Date(d as string);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Per-UDI optical-confirmation results, restricted to cartridges belonging to
 * the run. `sinceByUdi` maps each member UDI to the moment it joined the run;
 * a cartridge counts when it was assigned OR completed at/after that moment.
 *
 * Read-only and derived — never writes to cartridge_records.
 */
export async function loadOpticalByUdi(
	sinceByUdi: Record<string, Date>
): Promise<Record<string, SpuOpticalSummary>> {
	const udis = Object.keys(sinceByUdi);
	if (udis.length === 0) return {};

	// One query for the whole run: widen to the earliest member join time, then
	// apply each member's own cut-off while bucketing.
	const earliest = new Date(Math.min(...udis.map((u) => sinceByUdi[u].getTime())));

	const records = await CartridgeRecord.find({
		...OPTICAL_CARTRIDGE_FILTER,
		'device.name': { $in: udis },
		$and: [{
			$or: [
				{ createdAt: { $gte: earliest } },
				{ 'checkpoints.completed.when': { $gte: earliest } }
			]
		}]
	})
		.select('serialNumber assayId assayName status checkpoints createdAt rawData device')
		.sort({ createdAt: -1 })
		.limit(500)
		.lean() as any[];

	const out: Record<string, SpuOpticalSummary> = {};
	for (const udi of udis) {
		out[udi] = { cartridges: [], channels: [], meanByChannel: {}, latestRanAt: null };
	}

	for (const c of records) {
		const udi: string | undefined = c?.device?.name;
		if (!udi || !out[udi]) continue;

		const since = sinceByUdi[udi];
		const assignedAt = iso(c.createdAt);
		const completedAt = iso(c.checkpoints?.completed?.when);
		const inRun =
			(assignedAt !== null && new Date(assignedAt) >= since) ||
			(completedAt !== null && new Date(completedAt) >= since);
		if (!inRun) continue;

		// No readings yet (still `linked`/`underway`) — nothing to show or judge.
		const analysis = computeOpticalAnalysis(c);
		if (!analysis) continue;

		out[udi].cartridges.push({
			barcode: c._id, // cartridge_records _id IS the scanned barcode
			serialNumber: c.serialNumber ?? null,
			status: c.status ?? 'linked',
			assignedAt,
			ranAt: completedAt ?? iso(c.checkpoints?.underway?.when) ?? assignedAt,
			readingCount: analysis.readingCount,
			scanGroup: analysis.scanGroup,
			ratioByChannel: analysis.ratioByChannel
		});
	}

	for (const udi of udis) {
		const entry = out[udi];
		const channels = new Set<string>();
		for (const cart of entry.cartridges) {
			for (const ch of Object.keys(cart.ratioByChannel)) channels.add(ch);
		}
		entry.channels = [...channels].sort((a, b) => a.localeCompare(b));

		for (const ch of entry.channels) {
			const values = entry.cartridges
				.map((cart) => cart.ratioByChannel[ch])
				.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
			entry.meanByChannel[ch] = values.length
				? values.reduce((a, b) => a + b, 0) / values.length
				: null;
		}

		entry.latestRanAt = entry.cartridges
			.map((cart) => cart.ranAt)
			.filter((v): v is string => !!v)
			.sort()
			.at(-1) ?? null;
	}

	return out;
}
