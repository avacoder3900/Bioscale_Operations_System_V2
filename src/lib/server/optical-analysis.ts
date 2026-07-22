// VALIDATION-04: optical-confirmation analysis — per-channel F7/F3 ratio of
// summed fluorometer bands, the same readout as the research app. Derived and
// non-destructive: reads cartridge_records.rawData.readings[], never writes.

export interface OpticalChannelAnalysis {
	channel: string;
	n: number;
	f3Sum: number;
	f5Sum: number;
	f7Sum: number;
	f7f3: number | null;
	f5f3: number | null;
}

export interface OpticalAnalysis {
	readingCount: number;
	baselineScans: number | null;
	testScans: number | null;
	// Which readings the primary ratios cover: the post-baseline "test" scans
	// when the baseline split is known (research-app parity), else the whole run.
	scanGroup: 'test' | 'all';
	channels: OpticalChannelAnalysis[];
	allChannels: OpticalChannelAnalysis[];
	ratioByChannel: Record<string, number | null>;
}

function analyzeGroup(readings: any[]): Map<string, OpticalChannelAnalysis> {
	const byChannel = new Map<string, OpticalChannelAnalysis>();
	for (const r of readings) {
		const ch = r?.channel ?? '(none)';
		let entry = byChannel.get(ch);
		if (!entry) {
			entry = { channel: ch, n: 0, f3Sum: 0, f5Sum: 0, f7Sum: 0, f7f3: null, f5f3: null };
			byChannel.set(ch, entry);
		}
		entry.n++;
		if (typeof r?.f3 === 'number') entry.f3Sum += r.f3;
		if (typeof r?.f5 === 'number') entry.f5Sum += r.f5;
		if (typeof r?.f7 === 'number') entry.f7Sum += r.f7;
	}
	for (const entry of byChannel.values()) {
		entry.f7f3 = entry.f3Sum !== 0 ? entry.f7Sum / entry.f3Sum : null;
		entry.f5f3 = entry.f3Sum !== 0 ? entry.f5Sum / entry.f3Sum : null;
	}
	return byChannel;
}

function sortedChannels(m: Map<string, OpticalChannelAnalysis>): OpticalChannelAnalysis[] {
	return [...m.values()].sort((a, b) => a.channel.localeCompare(b.channel));
}

export function computeOpticalAnalysis(cartridge: any): OpticalAnalysis | null {
	const readings: any[] = Array.isArray(cartridge?.rawData?.readings)
		? cartridge.rawData.readings
		: [];
	if (readings.length === 0) return null;

	const baselineScans = typeof cartridge?.rawData?.baselineScans === 'number'
		? cartridge.rawData.baselineScans : null;
	const testScans = typeof cartridge?.rawData?.testScans === 'number'
		? cartridge.rawData.testScans : null;

	const hasSplit = baselineScans !== null && baselineScans > 0 && baselineScans < readings.length;
	const primaryReadings = hasSplit ? readings.slice(baselineScans) : readings;

	const primary = sortedChannels(analyzeGroup(primaryReadings));
	const all = sortedChannels(analyzeGroup(readings));

	const ratioByChannel: Record<string, number | null> = {};
	for (const c of primary) ratioByChannel[c.channel] = c.f7f3;

	return {
		readingCount: readings.length,
		baselineScans,
		testScans,
		scanGroup: hasSplit ? 'test' : 'all',
		channels: primary,
		allChannels: all,
		ratioByChannel
	};
}
