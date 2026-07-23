// Port of the research app's analysis engine (brevitest-research-v2
// src/lib/server/analysis.ts) so BIMS computes identical per-cartridge results
// from the shared analysis_profiles collection. Pure functions — no DB access,
// no side effects; keep the math in lockstep with the research app.

export interface ScanGroupDefinition {
	label: string;
	scanCount: number;
	startIndex: number;
}

export interface AnalysisProfileConfig {
	_id: string;
	name: string;
	description?: string;
	scanGroupDetection: 'bcode' | 'manual';
	scanGroupLabels: string[];
	manualScanGroups: number[];
	sumColumns: string[];
	denominatorColumn: string;
	ratioNumerators: string[];
	ratioScanGroups: number[];
	outputColumns: string[];
	outputScanGroups: number[];
	outputChannels: string[];
}

export interface ChannelAnalysis {
	sums: Record<string, number>;
	ratios: Record<string, number>;
}

export interface ScanGroupAnalysis {
	label: string;
	scanRange: string;
	scanCount: number;
	channels: Record<string, ChannelAnalysis>;
}

export interface CartridgeAnalysisOutput {
	channel: string;
	scanGroupLabel: string;
	scanGroupIndex: number;
	column: string;
	value: number;
}

export interface CartridgeAnalysis {
	profileId: string;
	profileName: string;
	computedAt: string;
	computedBy: string;
	scanGroups: ScanGroupAnalysis[];
	outputs: CartridgeAnalysisOutput[];
}

interface RawReading {
	number: number;
	channel: string;
	[column: string]: number | string;
}

/**
 * Parse BCODE to detect scan groups: each Repeat block containing a Read
 * Sensor command is one group of `count` scans. Consecutive sensor-Repeats
 * separated only by Delay instructions merge into a single group.
 */
export function detectScanGroupsFromBCODE(
	bcodeArray: unknown[],
	labels: string[]
): ScanGroupDefinition[] {
	const sensorCommands = new Set(['read sensor', 'read baseline', 'read test']);

	const cmdOf = (inst: unknown): string =>
		((inst as Record<string, unknown>)?.command as string)?.toLowerCase?.() ?? '';

	const isSensorRepeat = (inst: unknown): boolean => {
		if (cmdOf(inst) !== 'repeat') return false;
		const nested = ((inst as Record<string, unknown>).code as Record<string, unknown>[]) ?? [];
		return nested.some((c) => sensorCommands.has(cmdOf(c)));
	};

	const repeatCount = (inst: unknown): number =>
		parseInt(String((inst as Record<string, unknown>).count), 10) || 0;

	const groups: ScanGroupDefinition[] = [];
	let runningIndex = 0;
	let i = 0;

	while (i < bcodeArray.length) {
		if (!isSensorRepeat(bcodeArray[i])) {
			i++;
			continue;
		}

		let mergedCount = repeatCount(bcodeArray[i]);
		let j = i + 1;

		while (j < bcodeArray.length) {
			let k = j;
			while (k < bcodeArray.length && cmdOf(bcodeArray[k]) === 'delay') k++;
			if (k < bcodeArray.length && isSensorRepeat(bcodeArray[k])) {
				mergedCount += repeatCount(bcodeArray[k]);
				j = k + 1;
			} else {
				break;
			}
		}

		groups.push({
			label: labels[groups.length] ?? `Scan Group ${groups.length + 1}`,
			scanCount: mergedCount,
			startIndex: runningIndex
		});
		runningIndex += mergedCount;
		i = j;
	}

	return groups;
}

export function buildManualScanGroups(
	counts: number[],
	labels: string[]
): ScanGroupDefinition[] {
	let runningIndex = 0;
	return counts.map((count, i) => {
		const group: ScanGroupDefinition = {
			label: labels[i] ?? `Scan Group ${i + 1}`,
			scanCount: count,
			startIndex: runningIndex
		};
		runningIndex += count;
		return group;
	});
}

/**
 * Core analysis: raw readings + scan groups + profile config → per-group,
 * per-channel sums and ratios plus the profile's configured output values.
 */
export function computeAnalysis(
	readings: RawReading[],
	scanGroups: ScanGroupDefinition[],
	profile: AnalysisProfileConfig,
	meta: { profileId: string; profileName: string; computedBy: string }
): CartridgeAnalysis {
	const channels = profile.outputChannels.length > 0 ? profile.outputChannels : ['A', 'B', 'C'];
	const scanGroupResults: ScanGroupAnalysis[] = [];

	for (let gi = 0; gi < scanGroups.length; gi++) {
		const { label, scanCount, startIndex } = scanGroups[gi];
		const endIndex = startIndex + scanCount;
		const scanRange = `${startIndex}-${endIndex - 1}`;

		const channelResults: Record<string, ChannelAnalysis> = {};

		for (const channel of channels) {
			const groupReadings = readings.filter(
				(r) => r.channel === channel && r.number >= startIndex && r.number < endIndex
			);

			const sums: Record<string, number> = {};
			for (const col of profile.sumColumns) {
				sums[col] = groupReadings.reduce(
					(sum, r) => sum + ((r as Record<string, number>)[col] ?? 0),
					0
				);
			}

			const ratios: Record<string, number> = {};
			if (profile.ratioScanGroups.includes(gi)) {
				const denominator = sums[profile.denominatorColumn] ?? 0;
				if (denominator !== 0) {
					for (const numerator of profile.ratioNumerators) {
						ratios[`${numerator}/${profile.denominatorColumn}`] = (sums[numerator] ?? 0) / denominator;
					}
				}
			}

			channelResults[channel] = { sums, ratios };
		}

		scanGroupResults.push({ label, scanRange, scanCount, channels: channelResults });
	}

	const outputs: CartridgeAnalysisOutput[] = [];
	for (let gi = 0; gi < scanGroupResults.length; gi++) {
		if (!profile.outputScanGroups.includes(gi)) continue;
		const group = scanGroupResults[gi];

		for (const channel of profile.outputChannels) {
			const channelData = group.channels[channel];
			if (!channelData) continue;

			for (const col of profile.outputColumns) {
				let value: number | undefined;

				if (col.includes('/')) {
					value = channelData.ratios[col];
				} else if (col.endsWith('_raw')) {
					value = channelData.sums[col.replace('_raw', '')];
				}

				if (value !== undefined) {
					outputs.push({
						channel,
						scanGroupLabel: group.label,
						scanGroupIndex: gi,
						column: col,
						value
					});
				}
			}
		}
	}

	return {
		profileId: meta.profileId,
		profileName: meta.profileName,
		computedAt: new Date().toISOString(),
		computedBy: meta.computedBy,
		scanGroups: scanGroupResults,
		outputs
	};
}
