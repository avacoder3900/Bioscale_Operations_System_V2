/**
 * Chute barcode scans (2026-11-16): the arm Pi scans the cartridge label after
 * a trapdoor fire step with "Scan Barcode After" (services/robot-arm barcode.py)
 * and posts each scan to /api/robot-arm/chute-scans. Pure helpers, shared by
 * the API, the warning and their tests.
 */

export const MAX_SCANS_PER_POST = 50;

/** Same rule as bucket-service isCartBarcode and barcode.py is_label. */
export function isWholeCartLabel(code: string | null | undefined): boolean {
	const s = (code ?? '').trim();
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^CART-\d{6}$/i.test(s);
}

export interface ChuteScanInput {
	at: Date;
	ok: boolean;
	code: string | null;
	label: boolean;
	error: string | null;
	elapsedMs: number | null;
	solenoid: string | null;
	pin: number | null;
	runId: string | null;
	title: string | null;
	piScanId: string | null;
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/**
 * The Pi's body `{ host?, scans: [{ at, ok, code, label, error, elapsed_ms, solenoid, pin, run_id, title, id }] }`.
 * `ok` is recomputed here: a scan counts only when it read a whole cartridge label,
 * whatever the Pi said.
 */
export function parseChuteScansBody(body: unknown): { host: string | null; scans: ChuteScanInput[] } {
	const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
	const raw = Array.isArray(b.scans) ? b.scans.slice(0, MAX_SCANS_PER_POST) : [];
	const scans = raw.map((r): ChuteScanInput => {
		const s = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
		const code = str(s.code, 120);
		const label = isWholeCartLabel(code);
		const at = typeof s.at === 'string' && !Number.isNaN(Date.parse(s.at)) ? new Date(s.at) : new Date();
		const ok = s.ok === true && label;
		let error = str(s.error, 300);
		if (!ok && !error) error = code ? 'not a whole cartridge label' : 'no barcode read';
		return {
			at,
			ok,
			code,
			label,
			error: ok ? null : error,
			elapsedMs: int(s.elapsed_ms),
			solenoid: str(s.solenoid, 20),
			pin: int(s.pin),
			runId: str(s.run_id, 80),
			title: str(s.title, 200),
			piScanId: str(s.id, 80)
		};
	});
	return { host: str(b.host, 80), scans };
}

/** The Movement Log line for a scan. */
export function chuteScanLine(s: Pick<ChuteScanInput, 'ok' | 'code' | 'error' | 'solenoid'>): string {
	const where = s.solenoid ? ` After Solenoid ${s.solenoid}` : '';
	return s.ok ? `Chute Barcode Scan${where}  ${s.code}` : `Chute Barcode Scan${where}  Failed: ${s.error ?? 'no barcode read'}${s.code ? ` (${s.code})` : ''}`;
}

/** The warning a failed scan raises on the arm pages. */
export interface ChuteScanWarning {
	_id: string;
	at: string;
	code: string | null;
	error: string | null;
	solenoid: string | null;
	title: string | null;
	/** Failed scans since the last Close, this one included. */
	failedCount: number;
}

/** "⚠ Chute Scan Failed: no barcode read" with where and when. */
export function chuteWarningText(w: ChuteScanWarning, now: Date = new Date()): string {
	const what = w.error ?? 'no barcode read';
	const code = w.code ? ` (${w.code})` : '';
	const after = w.solenoid ? ` after Solenoid ${w.solenoid}` : '';
	const run = w.title ? ` in ${w.title}` : '';
	const more = w.failedCount > 1 ? ` · ${w.failedCount} failed scans` : '';
	return `Chute Scan Failed: ${what}${code}${after}${run}, ${agoText(new Date(w.at), now)}${more}`;
}

function agoText(at: Date, now: Date): string {
	const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
	if (s < 60) return `${s} s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	return `${Math.round(m / 60)} h ago`;
}
