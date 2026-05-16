<script lang="ts">
	import { Bar } from 'svelte-chartjs';
	import {
		Chart as ChartJS,
		Title,
		Tooltip,
		Legend,
		BarElement,
		LinearScale,
		CategoryScale
	} from 'chart.js';

	ChartJS.register(Title, Tooltip, Legend, BarElement, LinearScale, CategoryScale);

	interface ThroughputPoint {
		weekStart: string;
		total: number;
	}

	interface Props {
		points: ThroughputPoint[];
	}

	let { points }: Props = $props();

	let chartData = $derived({
		labels: points.map((p) => p.weekStart),
		datasets: [
			{
				label: 'Tasks completed',
				data: points.map((p) => p.total),
				backgroundColor: '#00ff88',
				borderColor: '#00ff88',
				borderWidth: 1
			}
		]
	});

	const chartOptions = {
		responsive: true,
		maintainAspectRatio: false,
		scales: {
			x: { ticks: { color: '#a0a0a0', maxTicksLimit: 8 }, grid: { color: 'rgba(160,160,160,0.1)' } },
			y: { beginAtZero: true, ticks: { color: '#a0a0a0' }, grid: { color: 'rgba(160,160,160,0.1)' } }
		},
		plugins: {
			legend: { display: false },
			tooltip: { mode: 'index' as const, intersect: false }
		}
	};
</script>

<div class="tron-card p-4">
	<h3 class="tron-text-primary mb-3 text-sm font-bold">Throughput (per week)</h3>
	{#if points.length === 0}
		<p class="tron-text-muted text-xs">No completions in range.</p>
	{:else}
		<div style="height: 260px;">
			<Bar data={chartData} options={chartOptions} />
		</div>
	{/if}
</div>
