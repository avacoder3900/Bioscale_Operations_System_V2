/**
 * Legacy assay shape utilities.
 *
 * The 238 assays imported from the prior system all use a specific document
 * shape: `_id` in "A" + 7 uppercase hex format, a top-level `BCODE` field
 * (object with `deviceParams` and `code` array, Title Case commands,
 * object-valued params), and `hidden`/`protected` Boolean markers.
 *
 * BIMS creation paths go through this module so new documents match that
 * shape. Any ambiguity about firmware command vocabulary is called out in
 * docs/assay-shape-report.md — update the mapping tables below as the
 * firmware contract firms up.
 */

import { randomBytes } from 'node:crypto';

/**
 * Legacy `_id` format: literal "A" followed by 7 uppercase hex chars.
 * 28 bits of entropy → ~2^14 docs before 50% collision probability. With
 * 238 existing, we're nowhere near saturation, but we still collision-
 * check against the collection before returning.
 */
export async function generateLegacyAssayId(
	AssayDefinition: { exists: (q: { _id: string }) => Promise<unknown> }
): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const candidate = 'A' + randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
		const taken = await AssayDefinition.exists({ _id: candidate });
		if (!taken) return candidate;
	}
	throw new Error('Failed to generate unique legacy assay ID after 10 attempts');
}

/** Default `deviceParams` object — observed constant across legacy docs that have it. */
export const DEFAULT_DEVICE_PARAMS = Object.freeze({
	delayBetweenSensorReadings: 100,
	integrationTime: 128,
	gain: 0,
	ledPower: 300
});

/**
 * UI instruction shape (what `BcodeEditor.svelte` emits) → legacy BCODE.code
 * instruction shape. Example UI instr: `{ type: 'MOVE_MICRONS', params: [2850, 5000] }`
 * Example legacy instr: `{ command: 'Move Microns', params: { microns: 2850, step_delay_us: 5000 } }`
 */
type UiInstruction = { type: string; params?: number[]; code?: UiInstruction[] };
type LegacyInstruction =
	| { command: string; params: Record<string, unknown> }
	| { command: 'Repeat'; count: number; code: LegacyInstruction[]; params?: Record<string, unknown> };

const OPCODE_TO_LEGACY: Record<string, { command: string; paramKeys: string[] }> = {
	START_TEST: { command: 'Start Test', paramKeys: [] },
	END_TEST: { command: 'Finish Test', paramKeys: [] },
	DELAY: { command: 'Delay', paramKeys: ['delay_ms'] },
	MOVE_MICRONS: { command: 'Move Microns', paramKeys: ['microns', 'step_delay_us'] },
	OSCILLATE: { command: 'Oscillate Stage', paramKeys: ['microns', 'step_delay_us', 'cycles'] },
	SENSOR_READING: { command: 'Read Sensor', paramKeys: ['channel', 'gain', 'step', 'time'] }
	// REPEAT_BEGIN is handled as a structured block below, not a flat row.
	// REPEAT_END is implicit in legacy (the Repeat block has an inline `code` array).
	// SET_SENSOR_PARAMS, BASELINE_SCANS, TEST_SCANS, CONTINUOUS_SCANS — no confirmed
	// legacy equivalent; see docs/assay-shape-report.md for open questions.
};

function translateInstructionList(list: UiInstruction[]): LegacyInstruction[] {
	const out: LegacyInstruction[] = [];
	for (const instr of list) {
		if (instr.type === 'REPEAT_END') continue; // implicit in legacy
		if (instr.type === 'REPEAT_BEGIN') {
			const count = instr.params?.[0] ?? 1;
			const inner = Array.isArray(instr.code) ? translateInstructionList(instr.code) : [];
			out.push({ command: 'Repeat', count, code: inner, params: {} });
			continue;
		}
		const mapping = OPCODE_TO_LEGACY[instr.type];
		if (mapping) {
			const params: Record<string, unknown> = {};
			const vals = instr.params ?? [];
			for (let i = 0; i < mapping.paramKeys.length; i++) {
				if (vals[i] !== undefined) params[mapping.paramKeys[i]] = vals[i];
			}
			out.push({ command: mapping.command, params });
		} else {
			// Fallback for opcodes without a confirmed legacy mapping. Preserve
			// the data as-is so nothing is silently lost; firmware/consumer can
			// either interpret or ignore.
			out.push({
				command: titleCase(instr.type),
				params: { raw_type: instr.type, raw_params: instr.params ?? [] }
			});
		}
	}
	return out;
}

function titleCase(opcode: string): string {
	return opcode.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Build the legacy BCODE object from UI instructions.
 * Returns `{ deviceParams, code: [...] }` — the object shape used by 235 of
 * 238 legacy docs. (The 3 "clinical" docs store `BCODE` as a bare array;
 * that shape is not emitted by BIMS.)
 */
export function toLegacyBcode(
	instructions: UiInstruction[],
	deviceParams: Record<string, unknown> = DEFAULT_DEVICE_PARAMS
): { deviceParams: Record<string, unknown>; code: LegacyInstruction[] } {
	return {
		deviceParams: { ...deviceParams },
		code: translateInstructionList(instructions)
	};
}
