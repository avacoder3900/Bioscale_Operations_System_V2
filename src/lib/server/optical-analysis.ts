export interface OpticalChannelAnalysis {
	channel: 'A' | 'B' | 'C';
	n: number;
	sums: { f3: number; f5: number; f7: number };
	ratios: { 'f7/f3': number | null; 'f5/f3': number | null };
}

export interface OpticalAnalysis {
	profileName: string;
	computedAt: string;
	denominatorColumn: 'f3';
	ratioNumerators: ['f5', 'f7'];
	channels: OpticalChannelAnalysis[];
	ratioByChannel: { A: number | null; B: number | null; C: number | null };
}

const CHANNELS: ReadonlyArray<'A' | 'B' | 'C'> = ['A', 'B', 'C'];

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function computeOpticalAnalysis(readings: unknown[]): OpticalAnalysis | null {
	if (!Array.isArray(readings) || readings.length === 0) return null;

	const channels: OpticalChannelAnalysis[] = [];
	const ratioByChannel: { A: number | null; B: number | null; C: number | null } = {
		A: null,
		B: null,
		C: null
	};

	for (const channel of CHANNELS) {
		let sumF3 = 0;
		let sumF5 = 0;
		let sumF7 = 0;
		let n = 0;

		for (const reading of readings) {
			if (!reading || typeof reading !== 'object') continue;
			const r = reading as Record<string, unknown>;
			if (r.channel !== channel) continue;
			n++;
			const f3 = num(r.f3);
			const f5 = num(r.f5);
			const f7 = num(r.f7);
			if (f3 !== null) sumF3 += f3;
			if (f5 !== null) sumF5 += f5;
			if (f7 !== null) sumF7 += f7;
		}

		const f7f3 = sumF3 === 0 ? null : sumF7 / sumF3;
		const f5f3 = sumF3 === 0 ? null : sumF5 / sumF3;

		channels.push({
			channel,
			n,
			sums: { f3: sumF3, f5: sumF5, f7: sumF7 },
			ratios: { 'f7/f3': f7f3, 'f5/f3': f5f3 }
		});

		ratioByChannel[channel] = f7f3;
	}

	return {
		profileName: 'Single Scan Cortisol',
		computedAt: new Date().toISOString(),
		denominatorColumn: 'f3',
		ratioNumerators: ['f5', 'f7'],
		channels,
		ratioByChannel
	};
}
