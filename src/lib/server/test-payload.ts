/**
 * Parser for the device's binary test record — the exact struct the firmware
 * publishes as `upload-test` (BrevitestTestRecord: 68-byte header + up to 360
 * × 32-byte readings = 11,588 bytes on v100+, then the v101 stage tail —
 * 11,604 bytes on v101, 11,628 on v102 — see parseStageTail). Ported from the Lambda middleware's
 * parseByteArray so BIMS can receive the same struct directly over a Particle
 * webhook for tests that never touch the cloud (blank-cartridge runs, v96).
 *
 * Particle delivers a BINARY publish to a webhook as the string
 * "data:application/octet-stream;base64,<payload>".
 */
export interface TestPayloadReading {
	number: number;
	channel: 'A' | 'B' | 'C' | string;
	position: number;
	temperature: number;
	laser_output: number;
	msec: number;
	f1: number;
	f2: number;
	f3: number;
	f4: number;
	f5: number;
	f6: number;
	f7: number;
	f8: number;
	clear: number;
	nir: number;
}

/**
 * The v101+ stage travel check, appended to the record after the readings
 * (brevitest-device Docs/V101_STAGE_CHECK_HANDOFF.md). Offsets are absolute:
 *   11588 uint8  version (1 = v101, 2 = v102)
 *   11589 uint8  flags: bit0 measured, bit1 switch NOT found
 *   11590 uint16 limit hits during moves (counter > 0)
 *   11592 int32  expected µm (counter when the end-of-test home began)
 *   11596 int32  measured µm (net steps to the click)
 *   11600 int32  first hit µm (−1 none)
 * v2 (firmware v102) adds:
 *   11604 uint32 total stage travel µm (odometer, oscillations included)
 *   11608 uint32 ms from the start of the end-of-test home to the click
 *   11612 uint32[4] ms since test start of the first four mid-move hits (0 = none)
 * Same field names the Lambda writes to cartridge_records.rawData.stageCheck,
 * plus the v2 ones, so the two sources read alike.
 */
export interface StageCheck {
	version: number;
	measured: boolean;
	switchFound: boolean;
	limitHits: number;
	expectedUm: number;
	measuredUm: number;
	/** expected − measured. + = switch closed early (travel lost going out). */
	endErrorUm: number;
	firstHitUm: number;
	travelUm?: number;
	homeMs?: number;
	hitMs?: number[];
}

export interface TestPayload {
	dataFormat: string;
	cartridgeId: string;
	assayId: string;
	/** Device epoch seconds. */
	startTime: number;
	duration: number;
	astep: number;
	atime: number;
	again: number;
	numberOfReadings: number;
	baselineScans: number;
	testScans: number;
	checksum: number;
	readings: TestPayloadReading[];
	/** Present on v101+ records (the 16/40-byte tail after the 360-reading buffer). */
	stageCheck: StageCheck | null;
}

const HEADER = 'data:application/octet-stream;base64,';
/** v100+ buffer: 360 readings. The stage tail starts right after it. */
const STAGE_TAIL_OFFSET = 68 + 360 * 32; // 11588
const STAGE_TAIL_V1_BYTES = 16;
const STAGE_TAIL_V2_BYTES = 40;

/** Parse the stage tail if the buffer carries one. Never throws. */
export function parseStageTail(buf: Buffer): StageCheck | null {
	if (buf.length < STAGE_TAIL_OFFSET + STAGE_TAIL_V1_BYTES) return null;
	const o = STAGE_TAIL_OFFSET;
	const version = buf.readUInt8(o);
	if (version < 1 || version > 2) return null;
	const flags = buf.readUInt8(o + 1);
	const out: StageCheck = {
		version,
		measured: (flags & 0x01) !== 0,
		switchFound: (flags & 0x02) === 0,
		limitHits: buf.readUInt16LE(o + 2),
		expectedUm: buf.readInt32LE(o + 4),
		measuredUm: buf.readInt32LE(o + 8),
		endErrorUm: buf.readInt32LE(o + 4) - buf.readInt32LE(o + 8),
		firstHitUm: buf.readInt32LE(o + 12)
	};
	if (version >= 2 && buf.length >= STAGE_TAIL_OFFSET + STAGE_TAIL_V2_BYTES) {
		out.travelUm = buf.readUInt32LE(o + 16);
		out.homeMs = buf.readUInt32LE(o + 20);
		const hits: number[] = [];
		for (let i = 0; i < 4; i++) {
			const v = buf.readUInt32LE(o + 24 + 4 * i);
			if (v > 0) hits.push(v);
		}
		out.hitMs = hits;
	}
	return out;
}

/** Decode a data-URL or bare base64 string to bytes; null when it is not base64. */
export function decodeRecordBytes(data: string): Buffer | null {
	if (typeof data !== 'string' || data.length === 0) return null;
	const b64 = data.startsWith(HEADER) ? data.slice(HEADER.length) : data;
	try {
		return Buffer.from(b64, 'base64');
	} catch {
		return null;
	}
}
const FREQ = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'] as const;
const READING_BYTES = 32;
const READINGS_OFFSET = 68;

function cstr(buf: Buffer, start: number, end: number): string {
	const raw = buf.subarray(start, end).toString('latin1');
	const nul = raw.indexOf('\0');
	return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
}

function parseReading(buf: Buffer, o: number): TestPayloadReading {
	const r: Record<string, unknown> = {
		number: buf.readUInt8(o),
		channel: buf.subarray(o + 1, o + 2).toString('latin1'),
		position: buf.readUInt16LE(o + 2),
		temperature: buf.readUInt16LE(o + 4),
		laser_output: buf.readUInt16LE(o + 6),
		msec: buf.readUInt32LE(o + 8)
	};
	FREQ.forEach((f, i) => {
		r[f] = buf.readUInt16LE(o + 12 + 2 * i);
	});
	return r as unknown as TestPayloadReading;
}

/** Parse a data-URL (or bare base64) test record. Returns null when the bytes cannot be a test record. */
export function parseTestPayload(data: string): TestPayload | null {
	if (typeof data !== 'string' || data.length === 0) return null;
	const buf = decodeRecordBytes(data);
	if (!buf) return null;
	return parseTestRecordBuffer(buf);
}

/** Parse an already-decoded BrevitestTestRecord. Returns null when the bytes cannot be a test record. */
export function parseTestRecordBuffer(buf: Buffer): TestPayload | null {
	if (buf.length < READINGS_OFFSET) return null;
	const numberOfReadings = buf.readUInt16LE(58);
	if (buf.length < READINGS_OFFSET + numberOfReadings * READING_BYTES) return null;
	const readings: TestPayloadReading[] = [];
	for (let i = 0; i < numberOfReadings; i++) readings.push(parseReading(buf, READINGS_OFFSET + i * READING_BYTES));
	readings.sort((a, b) => a.number - b.number);
	return {
		dataFormat: buf.subarray(0, 1).toString('latin1'),
		cartridgeId: cstr(buf, 1, 37),
		assayId: cstr(buf, 38, 46),
		startTime: buf.readUInt32LE(48),
		duration: buf.readUInt16LE(52),
		astep: buf.readUInt16LE(54),
		atime: buf.readUInt8(56),
		again: buf.readUInt8(57),
		numberOfReadings,
		baselineScans: buf.readUInt16LE(60),
		testScans: buf.readUInt16LE(62),
		checksum: buf.readUInt32LE(64),
		readings,
		stageCheck: parseStageTail(buf)
	};
}
