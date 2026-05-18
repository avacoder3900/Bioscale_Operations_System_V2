<script lang="ts">
	import { Line } from 'svelte-chartjs';
	import {
		Chart as ChartJS,
		Title,
		Tooltip,
		Legend,
		LineElement,
		LinearScale,
		PointElement,
		CategoryScale,
		Filler
	} from 'chart.js';

	ChartJS.register(Title, Tooltip, Legend, LineElement, LinearScale, PointElement, CategoryScale, Filler);

	interface CfdPoint {
		date: string;
		backlog: number;
		ready: number;
		wip: number;
		waiting: number;
		done: number;
	}

	interface Props {
		points: CfdPoint[];
	}

	let { points }: Props = $props();

	// Stack order bottom → top: done, wip, ready, waiting, backlog.
	// Rationale per PRD: done at bottom (banked work), backlog at top
	// (new scope pushes the top edge up).
	const bands = [
		{ key: 'done', label: 'Done', color: '#00ff88' },
		{ key: 'wip', label: 'WIP', color: '#ff6600' },
		{ key: 'ready', label: 'Ready', color: '#00d4ff' },
		{ key: 'waiting', label: 'Waiting', color: '#ff3366' },
		{ key: 'backlog', label: 'Backlog', color: '#a0a0a0' }
	] as const;

	let chartData = $derived({
		labels: points.map((p) => p.date),
		datasets: bands.map((b) => ({
			label: b.label,
			data: points.map((p) => p[b.key as keyof CfdPoint] as number),
			backgroundColor: `${b.color}40`,
			borderColor: b.color,
			borderWidth: 1,
			fill: true,
			tension: 0.2,
			pointRadius: 0,
			pointHoverRadius: 4
		}))
	});

	const chartOptions = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: { mode: 'index' as const, intersect: false },
		scales: {
			x: { ticks: { color: '#a0a0a0' }, grid: { color: 'rgba(160,160,160,0.1)' } },
			y: {
				stacked: true,
				beginAtZero: true,
				ticks: { color: '#a0a0a0' },
				grid: { color: 'rgba(160,160,160,0.1)' }
			}
		},
		plugins: {
			legend: { position: 'top' as const, labels: { color: '#e0e0e0', boxWidth: 12 } },
			tooltip: { mode: 'index' as const, intersect: false }
		}
	};
</script>

<div class="tron-card p-4">
	<h3 class="tron-text-primary mb-3 text-sm font-bold">Cumulative Flow Diagram</h3>
	{#if points.length === 0}
		<p class="tron-text-muted text-xs">Not enough data to render.</p>
	{:else}
		<div style="height: 360px;">
			<Line data={chartData} options={chartOptions} />
		</div>
	{/if}
</div>
