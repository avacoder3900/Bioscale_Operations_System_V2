import { createCanvas } from '@napi-rs/canvas';
import type { ChannelStats } from './thermocouple-stats';

const WIDTH = 800;
const HEIGHT = 400;
const PADDING = { top: 50, right: 30, bottom: 50, left: 70 };

const COLORS = {
	background: '#1a1a2e',
	grid: '#2a2a4a',
	text: '#e0e0e0',
	axis: '#4a4a6a',
	dataLine: '#00ffff',
	minLine: '#ff4444',
	maxLine: '#ff4444',
	safeZone: 'rgba(0, 255, 100, 0.08)',
	dangerZone: 'rgba(255, 68, 68, 0.08)'
};

const CHANNEL_COLORS: Record<string, string> = {
	ch1: '#00ffff',
	ch2: '#ff6b6b',
	ch3: '#51cf66',
	ch4: '#ffd43b'
};

/**
 * Generate a PNG chart for a single thermocouple channel.
 * Returns a base64-encoded PNG string.
 */
export async function generateChannelChartPng(
	channelName: string,
	values: number[],
	num: number[],
	minTemp: number,
	maxTemp: number,
	stats: ChannelStats
): Promise<string> {
	const canvas = createCanvas(WIDTH, HEIGHT);
	const ctx = canvas.getContext('2d');

	// Background
	ctx.fillStyle = COLORS.background;
	ctx.fillRect(0, 0, WIDTH, HEIGHT);

	const plotW = WIDTH - PADDING.left - PADDING.right;
	const plotH = HEIGHT - PADDING.top - PADDING.bottom;

	// Determine Y range (pad 5% beyond data or thresholds)
	const dataMin = Math.min(Math.min(...values), minTemp);
	const dataMax = Math.max(Math.max(...values), maxTemp);
	const yPad = (dataMax - dataMin) * 0.05 || 1;
	const yMin = dataMin - yPad;
	const yMax = dataMax + yPad;

	const xMin = num.length > 0 ? num[0] : 0;
	const xMax = num.length > 0 ? num[num.length - 1] : values.length - 1;
	const xRange = xMax - xMin || 1;

	function toX(i: number): number {
		return PADDING.left + ((i - xMin) / xRange) * plotW;
	}
	function toY(v: number): number {
		return PADDING.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
	}

	// Safe zone band
	ctx.fillStyle = COLORS.safeZone;
	const safeTop = toY(Math.min(maxTemp, yMax));
	const safeBottom = toY(Math.max(minTemp, yMin));
	ctx.fillRect(PADDING.left, safeTop, plotW, safeBottom - safeTop);

	// Grid lines (horizontal)
	ctx.strokeStyle = COLORS.grid;
	ctx.lineWidth = 0.5;
	const yTicks = 6;
	for (let i = 0; i <= yTicks; i++) {
		const v = yMin + (i / yTicks) * (yMax - yMin);
		const y = toY(v);
		ctx.beginPath();
		ctx.moveTo(PADDING.left, y);
		ctx.lineTo(WIDTH - PADDING.right, y);
		ctx.stroke();

		// Y axis labels
		ctx.fillStyle = COLORS.text;
		ctx.font = '11px sans-serif';
		ctx.textAlign = 'right';
		ctx.fillText(v.toFixed(1), PADDING.left - 8, y + 4);
	}

	// X axis labels
	const xTicks = Math.min(10, num.length);
	ctx.textAlign = 'center';
	for (let i = 0; i <= xTicks; i++) {
		const idx = Math.round((i / xTicks) * (num.length - 1));
		const x = toX(num[idx] ?? idx);
		ctx.fillStyle = COLORS.text;
		ctx.font = '11px sans-serif';
		ctx.fillText(String(num[idx] ?? idx), x, HEIGHT - PADDING.bottom + 20);
	}

	// Min/max threshold lines
	ctx.setLineDash([6, 4]);
	ctx.lineWidth = 1.5;
	ctx.strokeStyle = COLORS.minLine;

	ctx.beginPath();
	ctx.moveTo(PADDING.left, toY(minTemp));
	ctx.lineTo(WIDTH - PADDING.right, toY(minTemp));
	ctx.stroke();

	ctx.beginPath();
	ctx.moveTo(PADDING.left, toY(maxTemp));
	ctx.lineTo(WIDTH - PADDING.right, toY(maxTemp));
	ctx.stroke();

	// Threshold labels
	ctx.setLineDash([]);
	ctx.fillStyle = COLORS.minLine;
	ctx.font = '10px sans-serif';
	ctx.textAlign = 'left';
	ctx.fillText(`Min: ${minTemp}°C`, WIDTH - PADDING.right - 80, toY(minTemp) + 14);
	ctx.fillText(`Max: ${maxTemp}°C`, WIDTH - PADDING.right - 80, toY(maxTemp) - 6);

	// Data line
	const lineColor = CHANNEL_COLORS[channelName] ?? COLORS.dataLine;
	ctx.strokeStyle = lineColor;
	ctx.lineWidth = 1.5;
	ctx.lineJoin = 'round';
	ctx.beginPath();
	for (let i = 0; i < values.length; i++) {
		const x = toX(num[i] ?? i);
		const y = toY(values[i]);
		if (i === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	}
	ctx.stroke();

	// Title
	ctx.fillStyle = COLORS.text;
	ctx.font = 'bold 16px sans-serif';
	ctx.textAlign = 'center';
	const passLabel = stats.outOfRangeCount === 0 ? 'PASS' : 'FAIL';
	const passColor = stats.outOfRangeCount === 0 ? '#51cf66' : '#ff6b6b';
	ctx.fillText(`${channelName.toUpperCase()} Temperature`, WIDTH / 2 - 30, 28);
	ctx.fillStyle = passColor;
	ctx.fillText(`[${passLabel}]`, WIDTH / 2 + 100, 28);

	// Stats box
	ctx.fillStyle = 'rgba(26, 26, 46, 0.85)';
	ctx.fillRect(PADDING.left + 8, PADDING.top + 4, 200, 60);
	ctx.fillStyle = COLORS.text;
	ctx.font = '11px sans-serif';
	ctx.textAlign = 'left';
	ctx.fillText(`Avg: ${stats.average}°C  StdDev: ${stats.stdDev}°C`, PADDING.left + 14, PADDING.top + 20);
	ctx.fillText(`Min: ${stats.min}°C  Max: ${stats.max}°C`, PADDING.left + 14, PADDING.top + 36);
	ctx.fillText(`Range: ${stats.range}°C  Drift: ${stats.drift}°C`, PADDING.left + 14, PADDING.top + 52);

	// Axis labels
	ctx.fillStyle = COLORS.text;
	ctx.font = '12px sans-serif';
	ctx.textAlign = 'center';
	ctx.fillText('Reading Number', WIDTH / 2, HEIGHT - 6);

	ctx.save();
	ctx.translate(14, HEIGHT / 2);
	ctx.rotate(-Math.PI / 2);
	ctx.fillText('Temperature (°C)', 0, 0);
	ctx.restore();

	const pngBuffer = canvas.toBuffer('image/png');
	return Buffer.from(pngBuffer).toString('base64');
}
