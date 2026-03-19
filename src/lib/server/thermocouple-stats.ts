export interface ChannelStats {
	min: number;
	max: number;
	average: number;
	stdDev: number;
	cv: number;
	range: number;
	drift: number;
	readingCount: number;
	outOfRangeCount: number;
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

export function computeChannelStats(values: number[], minTemp: number, maxTemp: number): ChannelStats {
	const n = values.length;
	if (n === 0) {
		return { min: 0, max: 0, average: 0, stdDev: 0, cv: 0, range: 0, drift: 0, readingCount: 0, outOfRangeCount: 0 };
	}

	const min = Math.min(...values);
	const max = Math.max(...values);
	const sum = values.reduce((a, b) => a + b, 0);
	const average = sum / n;
	const variance = values.reduce((acc, t) => acc + (t - average) ** 2, 0) / n;
	const stdDev = Math.sqrt(variance);
	const cv = average !== 0 ? (stdDev / average) * 100 : 0;
	const range = max - min;
	const drift = n >= 2 ? values[n - 1] - values[0] : 0;
	const outOfRangeCount = values.filter(t => t < minTemp || t > maxTemp).length;

	return {
		min: round3(min),
		max: round3(max),
		average: round3(average),
		stdDev: round3(stdDev),
		cv: round3(cv),
		range: round3(range),
		drift: round3(drift),
		readingCount: n,
		outOfRangeCount
	};
}

export function computeOverallStats(
	channelStats: Record<string, ChannelStats>
): ChannelStats {
	const entries = Object.values(channelStats);
	if (entries.length === 0) {
		return { min: 0, max: 0, average: 0, stdDev: 0, cv: 0, range: 0, drift: 0, readingCount: 0, outOfRangeCount: 0 };
	}

	const totalReadings = entries.reduce((s, e) => s + e.readingCount, 0);
	return {
		min: round3(Math.min(...entries.map(e => e.min))),
		max: round3(Math.max(...entries.map(e => e.max))),
		average: round3(entries.reduce((s, e) => s + e.average, 0) / entries.length),
		stdDev: round3(entries.reduce((s, e) => s + e.stdDev, 0) / entries.length),
		cv: round3(entries.reduce((s, e) => s + e.cv, 0) / entries.length),
		range: round3(Math.max(...entries.map(e => e.range))),
		drift: round3(entries.reduce((s, e) => s + e.drift, 0) / entries.length),
		readingCount: totalReadings,
		outOfRangeCount: entries.reduce((s, e) => s + e.outOfRangeCount, 0)
	};
}

export function determinePassFail(
	channelStats: Record<string, ChannelStats>,
	minTemp: number,
	maxTemp: number
): { passed: boolean; failureReasons: string[]; interpretation: string; perChannel: Record<string, boolean> } {
	const perChannel: Record<string, boolean> = {};
	const failureReasons: string[] = [];

	for (const [ch, stats] of Object.entries(channelStats)) {
		const chPassed = stats.outOfRangeCount === 0;
		perChannel[ch] = chPassed;
		if (!chPassed) {
			if (stats.min < minTemp) {
				const belowCount = stats.outOfRangeCount; // approximate
				failureReasons.push(`${ch}: readings below minimum ${minTemp}°C (min observed: ${stats.min}°C)`);
			}
			if (stats.max > maxTemp) {
				failureReasons.push(`${ch}: readings above maximum ${maxTemp}°C (max observed: ${stats.max}°C)`);
			}
		}
	}

	const passed = Object.values(perChannel).every(Boolean);
	const totalReadings = Object.values(channelStats).reduce((s, e) => s + e.readingCount, 0);
	const totalOor = Object.values(channelStats).reduce((s, e) => s + e.outOfRangeCount, 0);

	const interpretation = passed
		? `All 4 channels within acceptable range (${minTemp}°C – ${maxTemp}°C), ${totalReadings} total readings`
		: `${totalOor} out-of-range readings across channels. Failing channels: ${Object.entries(perChannel).filter(([, v]) => !v).map(([k]) => k).join(', ')}`;

	return { passed, failureReasons, interpretation, perChannel };
}
