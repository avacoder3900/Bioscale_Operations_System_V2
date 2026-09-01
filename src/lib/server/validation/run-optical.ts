// Optical-confirmation results for a validation run, keyed by SPU UDI.
//
// There is no join table between a ValidationRun and the optical cartridges an
// SPU ran: the device writes a `device` block onto cartridge_records, and its
// `name` IS the SPU's UDI. So an SPU's optical results are recovered by
// matching device.name to the member UDI and keeping only the cartridges that
// belong to this run (assigned or completed at/after the SPU joined it).
//
// Derived on read, never written back — the same contract as optical-analysis.
import { CartridgeRecord } from '../db/models/index.js';
import { analyzeCartridge } from '../optical-analysis.js';
import { OPTICAL_CARTRIDGE_FILTER } from '../optical-constants.js';

export interface RunOpticalCartridge {
	barcode: string;
	serialNumber: string | null;
	status: string;
	assignedAt: string | null;
	ranAt: string | null;
	readingCount: number;
	ratioByChannel: { A: number | null; B: number | null; C: number | null };
	crossWellCv: number | null;
	rogueChannel: 'A' | 'B' | 'C' | null;
	warning: boolean;
	reasons: string[];
}

export interface RunOpticalSummary {
	cartridges: RunOpticalCartridge[];
	meanByChannel: { A: number | null; B: number | null; C: number | null };
	/** Any cartridge the analysis flagged — the operator should see why before ruling. */
	warningCount: number;
	latestRanAt: string | null;
}

const CHANNELS: ReadonlyArray<'A' | 'B' | 'C'> = ['A', 'B', 'C'];

function iso(d: unknown): string | null {
	if (!d) return null;
	const date = d instanceof Date ? d : new Date(d as string);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function emptySummary(): RunOpticalSummary {
	return {
		cartridges: [],
		meanByChannel: { A: null, B: null, C: null },
		warningCount: 0,
		latestRanAt: null
	};
}

/**
 * Per-UDI optical results, restricted to cartridges belonging to the run.
 * `sinceByUdi` maps each member UDI to the moment it joined the run; a
 * cartridge counts when it was assigned OR completed at/after that moment.
 */
export async function loadRunOpticalByUdi(
	sinceByUdi: Record<string, Date>
): Promise<Record<string, RunOpticalSummary>> {
	const udis = Object.keys(sinceByUdi);
	if (udis.length === 0) return {};

	// One query for the whole run: widen to the earliest member join time, then
	// apply each member's own cut-off while bucketing.
	const earliest = new Date(Math.min(...udis.map((u) => sinceByUdi[u].getTime())));

	const records = (await CartridgeRecord.find({
		...OPTICAL_CARTRIDGE_FILTER,
		'device.name': { $in: udis },
		$and: [
			{
				$or: [
					{ createdAt: { $gte: earliest } },
					{ 'checkpoints.completed.when': { $gte: earliest } }
				]
			}
		]
	})
		.select('serialNumber status checkpoints createdAt rawData device')
		.sort({ createdAt: -1 })
		.limit(500)
		.lean()) as any[];

	const out: Record<string, RunOpticalSummary> = {};
	for (const udi of udis) out[udi] = emptySummary();

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

		// Still `linked`/`underway` with no readings — nothing to show or judge.
		const readings = c.rawData?.readings;
		if (!Array.isArray(readings) || readings.length === 0) continue;
		const analysis = analyzeCartridge(readings);
		if (!analysis) continue;

		out[udi].cartridges.push({
			barcode: c._id, // cartridge_records _id IS the scanned barcode
			serialNumber: c.serialNumber ?? null,
			status: c.status ?? 'linked',
			assignedAt,
			ranAt: completedAt ?? iso(c.checkpoints?.underway?.when) ?? assignedAt,
			readingCount: readings.length,
			ratioByChannel: analysis.ratioByChannel,
			crossWellCv: analysis.crossWellCv,
			rogueChannel: analysis.rogueChannel,
			warning: analysis.warning,
			reasons: analysis.reasons ?? []
		});
	}

	for (const udi of udis) {
		const entry = out[udi];
		for (const ch of CHANNELS) {
			const values = entry.cartridges
				.map((cart) => cart.ratioByChannel[ch])
				.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
			entry.meanByChannel[ch] = values.length
				? values.reduce((a, b) => a + b, 0) / values.length
				: null;
		}
		entry.warningCount = entry.cartridges.filter((cart) => cart.warning).length;
		entry.latestRanAt =
			entry.cartridges
				.map((cart) => cart.ranAt)
				.filter((v): v is string => !!v)
				.sort()
				.at(-1) ?? null;
	}

	return out;
}
