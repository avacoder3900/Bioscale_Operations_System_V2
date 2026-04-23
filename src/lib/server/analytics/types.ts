/**
 * Shared types for the manufacturing-analytics module.
 * The canonical "process type" list lives here so every query speaks the same
 * vocabulary. Add new processes here first, then wire them into runs-feed.ts.
 */

export const PROCESS_TYPES = [
	'wi-01',
	'laser-cut',
	'cut-thermoseal',
	'cut-top-seal',
	'wax',
	'reagent',
	'top-seal',
	'qa-qc',
	'storage',
	'shipping',
	'general'
] as const;
export type ProcessType = (typeof PROCESS_TYPES)[number];

export const PROCESS_LABELS: Record<ProcessType, string> = {
	'wi-01': 'Cartridge Backing (WI-01)',
	'laser-cut': 'Laser Cutting',
	'cut-thermoseal': 'Cut Thermoseal',
	'cut-top-seal': 'Cut Top Seal',
	wax: 'Wax Filling',
	reagent: 'Reagent Filling',
	'top-seal': 'Top Seal Application',
	'qa-qc': 'QA / QC Release',
	storage: 'Storage',
	shipping: 'Shipping',
	general: 'General / Other'
};

export interface UnifiedRun {
	runId: string;
	processType: ProcessType;
	status: string;
	operator: string | null;
	operatorId: string | null;
	robotId: string | null;
	robotName: string | null;
	deckId: string | null;
	startTime: Date | null;
	endTime: Date | null;
	cycleTimeMin: number | null;
	plannedCount: number | null;
	actualCount: number | null;
	scrapCount: number | null;
	rejectedCount: number | null;
	acceptedCount: number | null;
	inputLots: { material?: string; barcode?: string }[];
	outputLotId?: string | null;
	outputBucketBarcode?: string | null;
	assayName?: string | null;
	abortReason?: string | null;
	notes?: string | null;
	createdAt: Date;
}

export interface GlobalFilters {
	from: Date | null;
	to: Date | null;
	processTypes: ProcessType[] | null;
	operatorIds: string[] | null;
	robotIds: string[] | null;
	equipmentIds: string[] | null;
	assayIds: string[] | null;
	inputLotBarcodes: string[] | null;
	shifts: ('morning' | 'afternoon' | 'night')[] | null;
}

export const SHIFTS: { id: 'morning' | 'afternoon' | 'night'; label: string; startHour: number; endHour: number }[] = [
	{ id: 'morning', label: 'Morning (06:00–14:00)', startHour: 6, endHour: 14 },
	{ id: 'afternoon', label: 'Afternoon (14:00–22:00)', startHour: 14, endHour: 22 },
	{ id: 'night', label: 'Night (22:00–06:00)', startHour: 22, endHour: 30 } // 30 = 06:00 next day
];

export function inferShift(d: Date): 'morning' | 'afternoon' | 'night' | null {
	if (!d) return null;
	const h = d.getHours();
	if (h >= 6 && h < 14) return 'morning';
	if (h >= 14 && h < 22) return 'afternoon';
	return 'night';
}
