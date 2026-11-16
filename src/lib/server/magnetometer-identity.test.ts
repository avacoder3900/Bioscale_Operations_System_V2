import { describe, it, expect } from 'vitest';
import {
	normaliseMagnetometerBarcode,
	pickMagnetometer,
	extractMagnetometerFromMagPayload,
	extractMagnetometerScans,
	decodeDeviceLogEvent,
	chooseScan,
	SCAN_WINDOWS
} from './magnetometer-identity';
import { parseSweepText } from './sweep/parse';
import { decodeSweepPayload } from './validation/mag-sweep-chunks';

const MAG1 = 'MAG-001-e00fce685d49ee5dc2a29545';
const MAG2 = 'MAG-002-0123456789abcdef01234567';

describe('normaliseMagnetometerBarcode', () => {
	it('keeps the full barcode and derives the short label', () => {
		expect(normaliseMagnetometerBarcode(MAG1)).toEqual({ barcode: MAG1, label: 'MAG-001' });
	});

	it('is case-insensitive and canonicalises the spelling', () => {
		expect(normaliseMagnetometerBarcode('mag-001-E00FCE685D49EE5DC2A29545')).toEqual({ barcode: MAG1, label: 'MAG-001' });
	});

	it('accepts a label with no hex suffix', () => {
		expect(normaliseMagnetometerBarcode('MAG-002')).toEqual({ barcode: 'MAG-002', label: 'MAG-002' });
	});

	it('strips whitespace, quotes and brackets a scanner or shell adds', () => {
		expect(normaliseMagnetometerBarcode(`  "${MAG1}"\r\n`)?.barcode).toBe(MAG1);
		expect(normaliseMagnetometerBarcode(`[${MAG1}]`)?.barcode).toBe(MAG1);
	});

	it('reads the barcode out of an object', () => {
		expect(normaliseMagnetometerBarcode({ barcode: MAG1 })?.label).toBe('MAG-001');
	});

	it('rejects everything that is not a magnetometer barcode', () => {
		for (const bad of [null, undefined, '', 42, 'MAG-1', 'MAG-0001', 'MAG-001-xyz', 'MAG-001-', 'BT-M01-0000-0211', 'SONIC-0000011', `x${MAG1}`, `${MAG1} extra`]) {
			expect(normaliseMagnetometerBarcode(bad)).toBeNull();
		}
	});
});

describe('pickMagnetometer', () => {
	it('reads each top-level body spelling', () => {
		for (const key of ['magnetometer', 'instrument', 'magBarcode']) {
			expect(pickMagnetometer({ [key]: MAG1 }, null)).toEqual({ barcode: MAG1, label: 'MAG-001', where: 'body' });
		}
	});

	it('reads each header / meta spelling', () => {
		for (const key of ['mag', 'magnetometer', 'instrument', 'jig']) {
			expect(pickMagnetometer({}, { [key]: MAG1 })).toEqual({ barcode: MAG1, label: 'MAG-001', where: 'meta' });
		}
	});

	it('matches keys case-insensitively and prefers the body', () => {
		expect(pickMagnetometer({ MagBarcode: MAG2 }, { mag: MAG1 })?.barcode).toBe(MAG2);
		expect(pickMagnetometer(null, { MAG: MAG1 })?.barcode).toBe(MAG1);
	});

	it('skips a malformed value and falls through to a good one', () => {
		expect(pickMagnetometer({ magnetometer: 'nope', instrument: MAG1 }, null)?.barcode).toBe(MAG1);
		expect(pickMagnetometer({ magnetometer: 'nope' }, { mag: MAG1 })?.where).toBe('meta');
	});

	it('returns null — never throws — when nothing usable was sent', () => {
		expect(pickMagnetometer(undefined, undefined)).toBeNull();
		expect(pickMagnetometer({ magnetometer: 12345 }, { mag: 'garbage', fw: 110 })).toBeNull();
		expect(pickMagnetometer('a string', [1, 2, 3])).toBeNull();
	});
});

// ---- firmware v110 sweep header -------------------------------------------

const MEAN_FIELDS = 'y,well,tA,xA,yA,zA,sdA,tB,xB,yB,zB,sdB,tC,xC,yC,zC,sdC';
const M_ROW = 'M\t1000\t1\t2500\t100\t200\t400000\t50\t2500\t100\t200\t400000\t50\t2500\t100\t200\t400000\t50';

/** The uploaded fmt=3 /sweep file: mag= sits after pitch, before format. */
function uploadedSweep(magToken: string | null): string {
	const head = [
		'SWPBEGIN', 'fmt=3', 'fw=110', 'id=1794844707', 'y0=1000', 'y1=40000', 'dy=200', 'n=8', 'settle=250',
		'points=1', 'wells=1', 'scale=100', 'zscale=0.25', 'seg=1', 'pitch=0',
		...(magToken ? [magToken] : []),
		'format=spu-mag-sweep-means/v1', `fields=${MEAN_FIELDS}`
	].join('\t');
	return [head, M_ROW, 'SWPEND\trows=1\tgood=8\tms=1000'].join('\n');
}

describe('sweep header mag= (uploaded /sweep file)', () => {
	it('parseSweepText keeps mag as the string the device sent', () => {
		const r = parseSweepText(uploadedSweep(`mag=${MAG1}`));
		if ('error' in r) throw new Error(r.error);
		expect(r.meta.mag).toBe(MAG1);
		expect(typeof r.meta.mag).toBe('string');
		expect(r.rows).toHaveLength(1);
		// The rest of the header is unaffected by the extra token.
		expect(r.meta.pitch).toBe(0);
		expect(r.meta.format).toBe('spu-mag-sweep-means/v1');
		expect(pickMagnetometer(null, r.meta)).toEqual({ barcode: MAG1, label: 'MAG-001', where: 'meta' });
	});

	it('parseSweepText: token omitted means null, not an error', () => {
		const r = parseSweepText(uploadedSweep(null));
		if ('error' in r) throw new Error(r.error);
		expect(r.meta.mag).toBeNull();
		expect(r.rows).toHaveLength(1);
	});

	it('parseSweepText: a malformed or unknown token never rejects the sweep', () => {
		for (const tok of ['mag=unknown', 'mag=', 'mag=12345', 'whatever=???', 'notakeyvalue']) {
			const r = parseSweepText(uploadedSweep(tok));
			if ('error' in r) throw new Error(`${tok}: ${r.error}`);
			expect(r.rows).toHaveLength(1);
			expect(pickMagnetometer(null, r.meta)).toBeNull();
		}
		// A numeric-looking value stays the string that was sent.
		const numeric = parseSweepText(uploadedSweep('mag=12345'));
		if ('error' in numeric) throw new Error(numeric.error);
		expect(numeric.meta.mag).toBe('12345');
	});

	it('decodeSweepPayload (chunk path) keeps meta.mag a string and surfaces the identity', () => {
		const d = decodeSweepPayload(uploadedSweep(`mag=${MAG1}`));
		expect(d.meta?.mag).toBe(MAG1);
		expect(d.magnetometer).toEqual({ barcode: MAG1, label: 'MAG-001', where: 'meta' });
		expect(d.rows).toHaveLength(1);
	});

	it('decodeSweepPayload: absent, malformed and numeric-looking values do not reject the sweep', () => {
		expect(decodeSweepPayload(uploadedSweep(null)).magnetometer).toBeNull();
		expect(decodeSweepPayload(uploadedSweep('mag=unknown')).magnetometer).toBeNull();
		const numeric = decodeSweepPayload(uploadedSweep('mag=12345'));
		expect(numeric.meta?.mag).toBe('12345');
		expect(numeric.magnetometer).toBeNull();
		expect(numeric.rows).toHaveLength(1);
	});
});

describe('sweep header mag= (serial fmt=2 line, last token)', () => {
	const RAW = 'S\t1000\t1\t0\t25.1\t1\t2\t4000\t25.2\t1\t2\t4000\t25.3\t1\t2\t4000';
	const serial = (tail: string) =>
		[`SWPBEGIN\tfmt=2\tfw=110\ty0=1000\ty1=40000\tdy=200\tn=8\tsettle=250\tpoints=1\twells=1\tzscale=0.25${tail}`, RAW, 'SWPEND\trows=1\tgood=1\tms=10'].join('\r\n');

	it('reads the identity when mag= is the last header token', () => {
		const d = decodeSweepPayload(serial(`\tmag=${MAG1}`));
		expect(d.format).toBe('spu-mag-sweep/v1');
		expect(d.meta?.mag).toBe(MAG1);
		expect(d.magnetometer?.barcode).toBe(MAG1);
	});

	it('works exactly as before without it', () => {
		const d = decodeSweepPayload(serial(''));
		expect(d.magnetometer).toBeNull();
		expect(d.rows).toHaveLength(1);
	});

	it('the bench route shape: meta.mag as the pusher parsed it', () => {
		expect(pickMagnetometer({ spu: '0211', rows: [] }, { fmt: 2, fw: 110, mag: MAG1 })).toEqual({
			barcode: MAG1, label: 'MAG-001', where: 'meta'
		});
	});
});

// ---- firmware v110 five-point test file ------------------------------------

const WELLS = [1, 2, 3, 4, 5].map((w) => `${w}\t25.1\t10\t20\t4100\t25.2\t11\t21\t4150\t25.3\t12\t22\t4200`);
const FILE_HEAD = ['/validation/magnet-1794250436.txt', 'Channel A\t\t\t Channel B\t\t\t Channel C'];

describe('extractMagnetometerFromMagPayload', () => {
	it('reads the trailing mag= line after the five well rows', () => {
		const raw = [...FILE_HEAD, ...WELLS, `mag=${MAG1}`, ''].join('\n');
		expect(extractMagnetometerFromMagPayload(raw)).toEqual({ barcode: MAG1, label: 'MAG-001' });
	});

	it('handles CRLF and upper-case hex', () => {
		const raw = [...FILE_HEAD, ...WELLS, `MAG=${MAG1.toUpperCase()}`].join('\r\n');
		expect(extractMagnetometerFromMagPayload(raw)?.barcode).toBe(MAG1);
	});

	it('returns null for a payload with no mag= line (every pre-v110 file)', () => {
		expect(extractMagnetometerFromMagPayload([...FILE_HEAD, ...WELLS].join('\n'))).toBeNull();
		expect(extractMagnetometerFromMagPayload('')).toBeNull();
		expect(extractMagnetometerFromMagPayload(null)).toBeNull();
	});

	it('takes the FIRST full line: a stale line left in the buffer after it is ignored', () => {
		const raw = [...FILE_HEAD, ...WELLS, `mag=${MAG1}`, '4150\t25.3\t12\t22\t4200', `mag=${MAG2}`].join('\n');
		expect(extractMagnetometerFromMagPayload(raw)?.barcode).toBe(MAG1);
	});

	it('ignores fragments: a truncated or run-together line is not an identity', () => {
		const truncated = [...FILE_HEAD, ...WELLS, 'mag=MAG-001-e00fce685d49'].join('\n');
		expect(extractMagnetometerFromMagPayload(truncated)).toBeNull();
		const tailOnly = [...FILE_HEAD, ...WELLS, 'fce685d49ee5dc2a29545'].join('\n');
		expect(extractMagnetometerFromMagPayload(tailOnly)).toBeNull();
		const glued = [...FILE_HEAD, ...WELLS, `22\t4200mag=${MAG1}`].join('\n');
		expect(extractMagnetometerFromMagPayload(glued)).toBeNull();
		const labelOnly = [...FILE_HEAD, ...WELLS, 'mag=MAG-001'].join('\n');
		expect(extractMagnetometerFromMagPayload(labelOnly)).toBeNull();
	});

	it('does not adopt a stale mag= line when the current file has none', () => {
		// Current (shorter, pre-v110 style) file, then the tail of an older, longer
		// payload still in the 1024-byte buffer: a row fragment and its mag= line.
		const raw = [...FILE_HEAD, ...WELLS, '.3\t12\t22\t4200', `mag=${MAG2}`].join('\n');
		expect(extractMagnetometerFromMagPayload(raw)).toBeNull();
	});
});

// ---- device logs -------------------------------------------------------------

const UPLOADED = new Date('2026-11-09T19:54:41.517Z');

describe('extractMagnetometerScans', () => {
	it('dates a scan from the state-transition line, which carries the device clock', () => {
		const scans = extractMagnetometerScans(
			[
				{ ms: 256704695, message: `T4 11-09 18:54:00 VALIDATING_MAGNETOMETER>IDLE [${MAG1}]` },
				{ ms: 256704696, message: `T5 11-09 18:53:50 BARCODE_SCANNING>VALIDATING_MAGNETOMETER [${MAG1}]` }
			],
			UPLOADED
		);
		// Only the transition INTO validation is a scan; the >IDLE line is not a second one.
		expect(scans).toHaveLength(1);
		expect(scans[0]).toMatchObject({ barcode: MAG1, label: 'MAG-001', timing: 'transition' });
		expect(scans[0].at?.toISOString()).toBe('2026-11-09T18:53:50.000Z');
	});

	it('dates a "Barcode scan result" line from the validation file written right after it', () => {
		const scans = extractMagnetometerScans(
			[
				{ ms: 253059649, message: `Barcode scan result: 2 (mode: BARCODE_SCANNING, barcode: ${MAG1})` },
				{ ms: 253065202, message: 'Connected to magnetometer' },
				{ ms: 253068662, message: 'write_magnet_validation_to_file, test size: 11628, event data size: 8413, file size: 489' },
				{ ms: 253069604, message: 'Latest validation file: /validation/magnet-1794250436.txt, bytes: 489' }
			],
			UPLOADED
		);
		expect(scans).toHaveLength(1);
		expect(scans[0].timing).toBe('validation-file');
		// 1794250436 s minus the 9955 ms between the two lines.
		expect(scans[0].at?.getTime()).toBe(1794250436000 - (253069604 - 253059649));
	});

	it('does not use the boot-time "Latest validation file" line (an old file on disk) as an anchor', () => {
		const scans = extractMagnetometerScans(
			[
				{ ms: 31604, message: `Barcode scan result: 2 (mode: BARCODE_SCANNING, barcode: ${MAG1})` },
				{ ms: 36086, message: 'Latest validation file: /validation/magnet-1790781907.txt, bytes: 481' }
			],
			UPLOADED
		);
		expect(scans).toHaveLength(1);
		expect(scans[0].at).toBeNull();
		expect(scans[0].timing).toBeNull();
	});

	it('anchors millis on a "Time:" line from the same boot only', () => {
		const lines = [
			{ ms: 16243, message: 'Time: 2026-11-16T16:58:56Z' },
			{ ms: 76243, message: `Barcode scan result: 2 (mode: BARCODE_SCANNING, barcode: ${MAG2})` },
			// millis went backwards: a different boot, so the anchor above is void.
			{ ms: 5000, message: 'I2C bus started' },
			{ ms: 9000, message: `Barcode scan result: 2 (mode: BARCODE_SCANNING, barcode: ${MAG1})` }
		];
		const scans = extractMagnetometerScans(lines, new Date('2026-11-16T17:30:00Z'));
		expect(scans).toHaveLength(2);
		expect(scans[0]).toMatchObject({ barcode: MAG2, timing: 'session-time' });
		expect(scans[0].at?.toISOString()).toBe('2026-11-16T16:59:56.000Z');
		expect(scans[1]).toMatchObject({ barcode: MAG1, at: null, timing: null });
	});

	it('ignores cartridge barcodes, other transitions and unrelated lines', () => {
		const scans = extractMagnetometerScans(
			[
				{ ms: 1, message: 'Barcode scan result: 1 (mode: BARCODE_SCANNING, barcode: 4c3fbb44-aaaa-bbbb-cccc-000000000000)' },
				{ ms: 2, message: 'T3 11-09 18:40:00 BARCODE_SCANNING>VALIDATING_CARTRIDGE [SONIC-0000011]' },
				{ ms: 3, message: 'Connected to magnetometer' },
				{ ms: 4, message: 'Magnetometer sweep complete: 7840 of 7840 readings good' },
				{ ms: 5, message: null },
				{}
			],
			UPLOADED
		);
		expect(scans).toEqual([]);
		expect(extractMagnetometerScans(null, UPLOADED)).toEqual([]);
	});

	it('puts a January transition in the upload year and a December one in the year before', () => {
		const up = new Date('2027-01-03T00:00:00Z');
		const scans = extractMagnetometerScans(
			[
				{ ms: 1, message: `T1 12-30 10:00:00 BARCODE_SCANNING>VALIDATING_MAGNETOMETER [${MAG1}]` },
				{ ms: 2, message: `T2 01-02 10:00:00 BARCODE_SCANNING>VALIDATING_MAGNETOMETER [${MAG1}]` }
			],
			up
		);
		expect(scans.map((s) => s.at?.toISOString())).toEqual(['2026-12-30T10:00:00.000Z', '2027-01-02T10:00:00.000Z']);
	});
});

describe('decodeDeviceLogEvent', () => {
	const text = `0|======== UPLOAD METADATA ========\n253059649|Barcode scan result: 2 (mode: BARCODE_SCANNING, barcode: ${MAG1})\n256704696|T5 11-09 18:53:50 BARCODE_SCANNING>VALIDATING_MAGNETOMETER [${MAG1}]\n`;
	const dataUrl = 'data:application/octet-stream;base64,' + Buffer.from(text, 'latin1').toString('base64');

	it('decodes a base64 data: URL into ms|message lines', () => {
		const lines = decodeDeviceLogEvent(dataUrl);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toEqual({ ms: 253059649, message: `Barcode scan result: 2 (mode: BARCODE_SCANNING, barcode: ${MAG1})` });
	});

	it('accepts plain text and the { raw } wrapper, and feeds the scan extractor', () => {
		expect(decodeDeviceLogEvent(text)).toHaveLength(3);
		const scans = extractMagnetometerScans(decodeDeviceLogEvent({ raw: dataUrl }), UPLOADED);
		expect(scans.find((s) => s.timing === 'transition')?.at?.toISOString()).toBe('2026-11-09T18:53:50.000Z');
	});

	it('returns nothing for a payload that is not a log', () => {
		expect(decodeDeviceLogEvent(null)).toEqual([]);
		expect(decodeDeviceLogEvent({ sessionId: 'x' })).toEqual([]);
		expect(decodeDeviceLogEvent(42)).toEqual([]);
	});
});

describe('chooseScan', () => {
	const scan = (barcode: string, iso: string | null) => ({
		...normaliseMagnetometerBarcode(barcode)!,
		at: iso ? new Date(iso) : null,
		timing: iso ? ('transition' as const) : null,
		ms: null
	});

	it('takes the most recent scan before the reading, inside the window', () => {
		const scans = [scan(MAG2, '2026-11-09T18:00:00Z'), scan(MAG1, '2026-11-09T18:53:50Z')];
		expect(chooseScan(scans, new Date('2026-11-09T19:16:32Z'), SCAN_WINDOWS.mag_sweep)?.barcode).toBe(MAG1);
	});

	it('leaves it empty when the only scan is too old, or is after the reading', () => {
		const reading = new Date('2026-11-09T19:16:32Z');
		expect(chooseScan([scan(MAG1, '2026-11-09T17:00:00Z')], reading, SCAN_WINDOWS.mag_sweep)).toBeNull();
		expect(chooseScan([scan(MAG1, '2026-11-09T19:30:00Z')], reading, SCAN_WINDOWS.mag_sweep)).toBeNull();
	});

	it('never matches a scan whose time is unknown', () => {
		expect(chooseScan([scan(MAG1, null)], new Date('2026-11-09T19:16:32Z'), SCAN_WINDOWS.mag_sweep)).toBeNull();
	});

	it('uses a tight window for the five-point test', () => {
		const reading = new Date('2026-11-09T18:53:56Z');
		expect(chooseScan([scan(MAG1, '2026-11-09T18:53:50Z')], reading, SCAN_WINDOWS.mag)?.barcode).toBe(MAG1);
		expect(chooseScan([scan(MAG1, '2026-11-09T18:30:00Z')], reading, SCAN_WINDOWS.mag)).toBeNull();
	});
});
