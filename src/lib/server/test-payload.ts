/**
 * Parser for the device's binary test record — the exact struct the firmware
 * publishes as `upload-test` (BrevitestTestRecord, 9668 bytes: 68-byte header
 * + up to 300 × 32-byte readings). Ported from the Lambda middleware's
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
}

const HEADER = 'data:application/octet-stream;base64,';
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
	const b64 = data.startsWith(HEADER) ? data.slice(HEADER.length) : data;
	let buf: Buffer;
	try {
		buf = Buffer.from(b64, 'base64');
	} catch {
		return null;
	}
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
		readings
	};
}
