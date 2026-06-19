// Chart generation placeholder — PNG chart generation requires @napi-rs/canvas
// which may not be available in all deployment environments.
// For now, channel data and stats are stored in the ValidationSession
// and can be used to render charts client-side.

import type { ChannelStats } from './thermocouple-stats';

/**
 * Generate a simple SVG chart string for a thermocouple channel.
 * Returns an SVG string (no native dependencies required).
 */
export function generateChannelChartSvg(
	channelName: string,
	values: number[],
	num: number[],
	minTemp: number,
	maxTemp: number,
	stats: ChannelStats
): string {
	const WIDTH = 800;
	const HEIGHT = 400;
	const PAD = { top: 50, right: 30, bottom: 50, left: 70 };
	const plotW = WIDTH - PAD.left - PAD.right;
	const plotH = HEIGHT - PAD.top - PAD.bottom;

	const CHANNEL_COLORS: Record<string, string> = {
		ch1: '#00ffff', ch2: '#ff6b6b', ch3: '#51cf66', ch4: '#ffd43b'
	};
	const lineColor = CHANNEL_COLORS[channelName] ?? '#00ffff';

	const dataMin = Math.min(Math.min(...values), minTemp);
	const dataMax = Math.max(Math.max(...values), maxTemp);
	const yPad = (dataMax - dataMin) * 0.05 || 1;
	const yMin = dataMin - yPad;
	const yMax = dataMax + yPad;
	const xMin = num[0] ?? 0;
	const xMax = num[num.length - 1] ?? values.length - 1;
	const xRange = xMax - xMin || 1;

	function toX(i: number): number { return PAD.left + ((i - xMin) / xRange) * plotW; }
	function toY(v: number): number { return PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

	// Build polyline points
	const points = values.map((v, i) => `${toX(num[i] ?? i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

	const passLabel = stats.outOfRangeCount === 0 ? 'PASS' : 'FAIL';
	const passColor = stats.outOfRangeCount === 0 ? '#51cf66' : '#ff6b6b';

	// Y-axis ticks
	const yTicks = 6;
	let yTickLines = '';
	for (let i = 0; i <= yTicks; i++) {
		const v = yMin + (i / yTicks) * (yMax - yMin);
		const y = toY(v);
		yTickLines += `<line x1="${PAD.left}" y1="${y}" x2="${WIDTH - PAD.right}" y2="${y}" stroke="#2a2a4a" stroke-width="0.5"/>`;
		yTickLines += `<text x="${PAD.left - 8}" y="${y + 4}" fill="#e0e0e0" font-size="11" text-anchor="end">${v.toFixed(1)}</text>`;
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
	<rect width="${WIDTH}" height="${HEIGHT}" fill="#1a1a2e"/>
	<!-- Safe zone -->
	<rect x="${PAD.left}" y="${toY(Math.min(maxTemp, yMax))}" width="${plotW}" height="${toY(Math.max(minTemp, yMin)) - toY(Math.min(maxTemp, yMax))}" fill="rgba(0,255,100,0.08)"/>
	<!-- Grid -->
	${yTickLines}
	<!-- Threshold lines -->
	<line x1="${PAD.left}" y1="${toY(minTemp)}" x2="${WIDTH - PAD.right}" y2="${toY(minTemp)}" stroke="#ff4444" stroke-width="1.5" stroke-dasharray="6,4"/>
	<line x1="${PAD.left}" y1="${toY(maxTemp)}" x2="${WIDTH - PAD.right}" y2="${toY(maxTemp)}" stroke="#ff4444" stroke-width="1.5" stroke-dasharray="6,4"/>
	<text x="${WIDTH - PAD.right - 80}" y="${toY(minTemp) + 14}" fill="#ff4444" font-size="10">Min: ${minTemp}°C</text>
	<text x="${WIDTH - PAD.right - 80}" y="${toY(maxTemp) - 6}" fill="#ff4444" font-size="10">Max: ${maxTemp}°C</text>
	<!-- Data line -->
	<polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round"/>
	<!-- Title -->
	<text x="${WIDTH / 2 - 30}" y="28" fill="#e0e0e0" font-size="16" font-weight="bold" text-anchor="center">${channelName.toUpperCase()} Temperature</text>
	<text x="${WIDTH / 2 + 100}" y="28" fill="${passColor}" font-size="16" font-weight="bold" text-anchor="center">[${passLabel}]</text>
	<!-- Stats -->
	<rect x="${PAD.left + 8}" y="${PAD.top + 4}" width="200" height="60" fill="rgba(26,26,46,0.85)"/>
	<text x="${PAD.left + 14}" y="${PAD.top + 20}" fill="#e0e0e0" font-size="11">Avg: ${stats.average}°C  StdDev: ${stats.stdDev}°C</text>
	<text x="${PAD.left + 14}" y="${PAD.top + 36}" fill="#e0e0e0" font-size="11">Min: ${stats.min}°C  Max: ${stats.max}°C</text>
	<text x="${PAD.left + 14}" y="${PAD.top + 52}" fill="#e0e0e0" font-size="11">Range: ${stats.range}°C  Drift: ${stats.drift}°C</text>
	<!-- Axis labels -->
	<text x="${WIDTH / 2}" y="${HEIGHT - 6}" fill="#e0e0e0" font-size="12" text-anchor="middle">Reading Number</text>
	<text x="14" y="${HEIGHT / 2}" fill="#e0e0e0" font-size="12" text-anchor="middle" transform="rotate(-90,14,${HEIGHT / 2})">Temperature (°C)</text>
</svg>`;
}
