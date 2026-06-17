/**
 * Derived timing metrics for a CartridgeRecord, computed from existing
 * timestamps — no schema fields, no writes.
 *
 * Wax cool time = waxFilling.runEndTime → ovenCure.exitTime
 *   (end of OT-2 wax fill → cartridges cooled, mirrors coolingWarningMin alert)
 *
 * Reagent seal time = reagentFilling.fillDate → topSeal.timestamp
 *   (end of OT-2 reagent fill → top seal applied, mirrors maxTimeBeforeSealMin deadline)
 *
 * Informational only — no new gates or stops.
 */

export interface CartridgeTiming {
	ms: number;
	minutes: number;
	display: string;
	startAt: string; // ISO
	endAt: string; // ISO
	overThresholdMin?: number | null;
}

export interface CartridgeTimings {
	cool: CartridgeTiming | null;
	seal: CartridgeTiming | null;
}

function toMs(v: Date | string | null | undefined): number | null {
	if (!v) return null;
	const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
	return isFinite(t) ? t : null;
}

function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/**
 * @param cartridge  CartridgeRecord lean document or its serialized form
 * @param thresholds Optional alert thresholds in minutes (cool = coolingWarningMin, seal = maxTimeBeforeSealMin)
 */
export function getCartridgeTimings(
	cartridge: any,
	thresholds?: { coolMin?: number; sealMin?: number }
): CartridgeTimings {
	const out: CartridgeTimings = { cool: null, seal: null };

	// Wax cool time
	const waxStart = toMs(cartridge?.waxFilling?.runEndTime);
	const waxEnd = toMs(cartridge?.ovenCure?.exitTime);
	if (waxStart && waxEnd && waxEnd > waxStart) {
		const ms = waxEnd - waxStart;
		const minutes = ms / 60000;
		out.cool = {
			ms,
			minutes: Math.round(minutes * 10) / 10,
			display: formatDuration(ms),
			startAt: new Date(waxStart).toISOString(),
			endAt: new Date(waxEnd).toISOString(),
			overThresholdMin: thresholds?.coolMin != null
				? Math.max(0, Math.round(minutes - thresholds.coolMin))
				: null
		};
	}

	// Reagent seal time
	const reagentStart = toMs(cartridge?.reagentFilling?.fillDate);
	const reagentEnd = toMs(cartridge?.topSeal?.timestamp);
	if (reagentStart && reagentEnd && reagentEnd > reagentStart) {
		const ms = reagentEnd - reagentStart;
		const minutes = ms / 60000;
		out.seal = {
			ms,
			minutes: Math.round(minutes * 10) / 10,
			display: formatDuration(ms),
			startAt: new Date(reagentStart).toISOString(),
			endAt: new Date(reagentEnd).toISOString(),
			overThresholdMin: thresholds?.sealMin != null
				? Math.max(0, Math.round(minutes - thresholds.sealMin))
				: null
		};
	}

	return out;
}
