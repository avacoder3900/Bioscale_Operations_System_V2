/**
 * ZPL generator for cartridge barcode labels on a Zebra ZT230 (or any ZPL II
 * printer). Pure + isomorphic: no DOM, no Mongoose, no SvelteKit — imported by
 * the print page (client) to build the job and by unit tests.
 *
 * Media (configurable): 2-across rows of 20 mm square labels (sold as ¾")
 * with a 0.13" gap between columns. Each ZPL format (^XA…^XZ) is one physical
 * ROW of the roll, i.e. up to `columns` labels, so the printer advances one
 * label length per format.
 *
 * Positional repeatability is achieved by (a) never using relative/auto
 * positioning — every element is placed at absolute dot coordinates computed
 * from the label geometry, and (b) exposing a per-printer x/y offset so the
 * whole design can be nudged into the die-cut once and stay there. Everything
 * else (gap sensing, top-of-form) is the printer's own media calibration.
 *
 * Label content mirrors the Avery 94102 sheet cell (see
 * routes/manufacturing/print-barcodes/+page.svelte sheetPng): "A B C" marks
 * along the top, the QR (raw UUID, same payload the scanners already resolve
 * as CartridgeRecord._id) centred below, and the UUID split across two
 * human-readable lines under the QR.
 */

export interface ZebraLabelConfig {
	/** Printhead resolution. ZT230 ships in 203 and 300 dpi variants. */
	dpi: number;
	labelWidthIn: number;
	labelHeightIn: number;
	/** Labels across the web. */
	columns: number;
	/** Horizontal gap between adjacent labels. */
	columnGapIn: number;
	/** Whole-design nudge, in dots. + = right / down. offsetY may be negative
	 *  (-120..120, sent as ^LT); negative offsetX clamps at the print origin. */
	offsetX: number;
	offsetY: number;
	/** ~SD absolute darkness 0–30. Omit to leave the printer setting alone. */
	darkness?: number;
	/** ^PR print speed in ips (ZT230: 2–6). Omit to leave the printer setting alone. */
	printSpeedIps?: number;
	/** QR module size in dots (^BQ magnification). 3 ≈ 0.49" symbol at 203 dpi. */
	qrMagnification: number;
	/** QR error correction: H | Q | M | L. */
	qrEcc: 'H' | 'Q' | 'M' | 'L';
	/** Draw the "A B C" position marks like the Avery layout. */
	abcMarks: boolean;
	/** Draw the UUID as text under the QR. */
	humanReadable: boolean;
}

// Calibrated on the lab ZT230-200dpi (serial 52J150301773) 2026-08-18 against
// the actual roll: labels are 20 mm × 20 mm (0.787"), not ¾" — the printer's
// own gap sensor reports 161 dots — with a 0.13" web between the two columns.
// TOF sat ~1 mm low, hence ^LT-8. Alignment rows landed on the die-cut on both
// columns with these values; treat them as the baseline, not a suggestion.
export const ZT230_2X_075_DEFAULTS: ZebraLabelConfig = {
	dpi: 203,
	labelWidthIn: 0.787,
	labelHeightIn: 0.787,
	columns: 2,
	columnGapIn: 0.13,
	offsetX: 0,
	offsetY: -8,
	qrMagnification: 3,
	qrEcc: 'M',
	abcMarks: true,
	humanReadable: true
};

export const ZEBRA_TEMPLATE_VERSION = 'zebra-zt230-2x075-v1';

/** UUID v4 as minted by mintCartridgeBarcodes. Anything else is refused so a
 *  `^` or `~` can never reach ^FD and be interpreted as a ZPL command. */
const SAFE_CODE = /^[0-9a-fA-F-]{8,64}$/;

// QR module counts by version (V1 = 21, +4 per version). A 36-char UUID in
// byte mode needs: V3-L (53 bytes) → 29 modules; V4-M (48) → 33; V5-Q (48)
// → 37; V6-H (44) → 41. Only used to compute the symbol footprint for
// layout; the printer picks the version itself from the data.
export function qrModulesForUuid(ecc: ZebraLabelConfig['qrEcc']): number {
	switch (ecc) {
		case 'L': return 29; // V3-L holds 53 bytes
		case 'M': return 33; // V4-M holds 48 bytes
		case 'Q': return 37; // V5-Q holds 48 bytes (V4-Q only 34)
		case 'H': return 41; // V6-H holds 44 bytes (V5-H only 34)
	}
}

export interface LabelGeometry {
	labelW: number;
	labelH: number;
	gap: number;
	/** Total print width in dots (^PW). */
	printWidth: number;
	/** ^LL in dots. */
	labelLength: number;
	qrSize: number;
	qrLeft: number;
	qrTop: number;
	abcTop: number;
	abcFont: number;
	abcLeft: number;
	abcSpacing: number;
	textTop: number;
	textFont: number;
	textLines: number;
}

const round = (n: number) => Math.round(n);

/** Pure layout math for one label; exported so the on-screen preview and the
 *  ZPL share exactly one geometry. */
export function computeGeometry(cfg: ZebraLabelConfig): LabelGeometry {
	const dpi = cfg.dpi;
	const labelW = round(cfg.labelWidthIn * dpi);
	const labelH = round(cfg.labelHeightIn * dpi);
	const gap = round(cfg.columnGapIn * dpi);
	const printWidth = cfg.columns * labelW + (cfg.columns - 1) * gap + Math.max(0, cfg.offsetX);

	// Avery cell proportions: ABC marks along the top starting 0.08" in with
	// 0.22" spacing; QR centred at 0.347" from the left edge (B column).
	const abcFont = cfg.abcMarks ? round(0.075 * dpi) : 0; // ≈15 dots @203 (was 12; "slightly bigger" — Jacob 2026-08-18)
	const abcTop = round(0.02 * dpi);
	const abcLeft = round(0.08 * dpi);
	const abcSpacing = round(0.22 * dpi);

	const qrSize = qrModulesForUuid(cfg.qrEcc) * cfg.qrMagnification;
	const qrCenterX = round(0.347 * dpi);
	const qrLeft = Math.max(0, qrCenterX - Math.floor(qrSize / 2));
	const qrTop = cfg.abcMarks ? abcTop + abcFont + round(0.02 * dpi) : round(0.04 * dpi);

	// Two text lines below the QR, sized to whatever height is left. If the
	// QR is so large there is no room, the text is dropped rather than
	// overrunning the label edge (which would print onto the next label).
	const textLines = cfg.humanReadable ? 2 : 0;
	const textTop = qrTop + qrSize + round(0.015 * dpi);
	const remaining = labelH - textTop - round(0.01 * dpi);
	let textFont = 0;
	if (textLines > 0) {
		// 18 chars per line must fit labelW; ^A0 is ~0.5×height per char.
		// Cap at 0.05" (10 dots @203): the UUID text is an internal aid, the QR
		// is what gets scanned — Jacob 2026-08-18: "that udi can be small".
		// The earlier 0.07" cap put line 2 on the bottom die-cut edge.
		const byWidth = Math.floor(labelW / (18 * 0.52));
		const byHeight = Math.floor(remaining / (textLines * 1.1));
		textFont = Math.min(round(0.05 * dpi), byWidth, byHeight);
	}
	const finalTextLines = textFont >= round(0.03 * dpi) ? textLines : 0;

	return {
		labelW, labelH, gap, printWidth,
		labelLength: labelH,
		qrSize, qrLeft, qrTop,
		abcTop, abcFont, abcLeft, abcSpacing,
		textTop, textFont, textLines: finalTextLines
	};
}

function header(cfg: ZebraLabelConfig, g: LabelGeometry): string {
	const parts = ['^XA'];
	// ^CI28 = UTF-8; harmless for hex, keeps behaviour deterministic across
	// printers whose default code page differs.
	parts.push('^CI28');
	parts.push(`^PW${g.printWidth}`);
	parts.push(`^LL${g.labelLength}`);
	parts.push('^LH0,0');
	// Vertical nudge via Label Top: ^LT accepts -120..120 dots and moves the
	// whole image, so a NEGATIVE offset (image starts above the printer's
	// sensed top-of-form) actually works — ^FO cannot go below 0. Verified on
	// the ZT230 2026-08-18: TOF sat ~1 mm below the die-cut edge; ^LT-8 fixes it.
	// X stays in ^FO arithmetic (positive shifts only; negative clamps at 0).
	const lt = Math.max(-120, Math.min(120, round(cfg.offsetY)));
	if (lt !== 0) parts.push(`^LT${lt}`);
	parts.push('^PON');   // normal orientation
	if (cfg.printSpeedIps !== undefined) parts.push(`^PR${Math.round(cfg.printSpeedIps)}`);
	return parts.join('');
}

function fo(x: number, y: number): string {
	// ^FO cannot be negative; clamp to the printable origin.
	return `^FO${Math.max(0, round(x))},${Math.max(0, round(y))}`;
}

/** One label's fields at column origin `cx` (dots). */
function labelFields(code: string, cx: number, cfg: ZebraLabelConfig, g: LabelGeometry): string {
	const ox = cx + cfg.offsetX;
	const oy = 0; // vertical offset is applied printer-wide via ^LT in header()
	const out: string[] = [];

	if (cfg.abcMarks) {
		for (let i = 0; i < 3; i++) {
			out.push(`${fo(ox + g.abcLeft + i * g.abcSpacing, oy + g.abcTop)}^A0N,${g.abcFont},${g.abcFont}^FD${'ABC'[i]}^FS`);
		}
	}

	// ^BQN,2,mag  → model 2 QR, module size = mag dots.
	// ^FD<ecc>A,<data> → automatic input mode; the printer chooses the version.
	out.push(`${fo(ox + g.qrLeft, oy + g.qrTop)}^BQN,2,${cfg.qrMagnification}^FD${cfg.qrEcc}A,${code}^FS`);

	if (g.textLines > 0) {
		const half = Math.ceil(code.length / 2);
		const lines = [code.slice(0, half), code.slice(half)];
		const lineH = round(g.textFont * 1.1);
		for (let i = 0; i < lines.length; i++) {
			// ^FB<width>,1,0,C  → one line, centred across the label width.
			out.push(
				`${fo(ox, oy + g.textTop + i * lineH)}^FB${g.labelW},1,0,C,0^A0N,${g.textFont},${round(g.textFont * 0.9)}^FD${lines[i]}^FS`
			);
		}
	}
	return out.join('');
}

export interface ZplJob {
	zpl: string;
	rows: number;
	labels: number;
	geometry: LabelGeometry;
}

/**
 * Build the print job for a list of barcodes. Labels fill each row left → right
 * before starting the next row; a final short row leaves its trailing
 * positions blank (they still advance past the printhead — the operator can
 * peel and discard the empties, which is why the caller should keep the count
 * a multiple of `columns` when it can).
 */
export function buildCartridgeLabelsZpl(barcodes: string[], cfg: ZebraLabelConfig = ZT230_2X_075_DEFAULTS): ZplJob {
	if (!Number.isInteger(cfg.columns) || cfg.columns < 1 || cfg.columns > 8) {
		throw new Error(`columns must be 1–8, got ${cfg.columns}`);
	}
	if (!Number.isInteger(cfg.qrMagnification) || cfg.qrMagnification < 1 || cfg.qrMagnification > 10) {
		throw new Error(`qrMagnification must be 1–10, got ${cfg.qrMagnification}`);
	}
	for (const b of barcodes) {
		if (!SAFE_CODE.test(b)) throw new Error(`Refusing to print unsafe barcode payload: ${JSON.stringify(b)}`);
	}
	const g = computeGeometry(cfg);
	const pitch = g.labelW + g.gap;
	const formats: string[] = [];
	// ~SD is a device setting, not per-format — send once at the top.
	const preamble = cfg.darkness !== undefined ? `~SD${String(Math.min(30, Math.max(0, Math.round(cfg.darkness)))).padStart(2, '0')}` : '';

	for (let i = 0; i < barcodes.length; i += cfg.columns) {
		const row = barcodes.slice(i, i + cfg.columns);
		let f = header(cfg, g);
		row.forEach((code, col) => { f += labelFields(code, col * pitch, cfg, g); });
		f += '^PQ1^XZ';
		formats.push(f);
	}
	return { zpl: preamble + formats.join('\n') + '\n', rows: formats.length, labels: barcodes.length, geometry: g };
}

/**
 * Feed `rows` blank rows (advance the media past the tear bar). An empty
 * ^XA^XZ is silently discarded by the printer, so print a single 1-dot mark
 * in the corner — invisible, but the format is real and the printer advances.
 */
export function buildFeedZpl(rows = 2, cfg: ZebraLabelConfig = ZT230_2X_075_DEFAULTS): ZplJob {
	const g = computeGeometry(cfg);
	const n = Math.max(1, Math.min(10, Math.round(rows)));
	const zpl = `^XA^PW${g.printWidth}^LL${g.labelLength}^FO2,2^GB1,1,1^FS^PQ${n}^XZ
`;
	return { zpl, rows: n, labels: n * cfg.columns, geometry: g };
}

/**
 * Alignment/test label: prints a 1-dot border on every label of one row plus
 * a centre cross and the word ALIGN. Nothing is minted; use it to dial in
 * offsetX/offsetY and verify the printer's media calibration before a real
 * batch. Every label in the row is identical so both columns can be checked.
 */
export function buildAlignmentZpl(cfg: ZebraLabelConfig = ZT230_2X_075_DEFAULTS): ZplJob {
	const g = computeGeometry(cfg);
	const pitch = g.labelW + g.gap;
	let f = header(cfg, g);
	for (let col = 0; col < cfg.columns; col++) {
		const ox = col * pitch + cfg.offsetX;
		const oy = 0; // vertical offset via ^LT in header()
		f += `${fo(ox, oy)}^GB${g.labelW},${g.labelH},1^FS`;
		f += `${fo(ox + g.labelW / 2 - 1, oy)}^GB2,${g.labelH},1^FS`;
		f += `${fo(ox, oy + g.labelH / 2 - 1)}^GB${g.labelW},2,1^FS`;
		const fh = round(0.08 * cfg.dpi);
		f += `${fo(ox, oy + round(0.06 * cfg.dpi))}^FB${g.labelW},1,0,C,0^A0N,${fh},${fh}^FDALIGN ${col + 1}^FS`;
		f += `${fo(ox, oy + g.labelH - round(0.16 * cfg.dpi))}^FB${g.labelW},1,0,C,0^A0N,${round(fh * 0.8)},${round(fh * 0.7)}^FDx${cfg.offsetX} y${cfg.offsetY}^FS`;
	}
	f += '^PQ1^XZ\n';
	return { zpl: f, rows: 1, labels: cfg.columns, geometry: g };
}
