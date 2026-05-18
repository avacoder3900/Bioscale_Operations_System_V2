<script lang="ts">
	import { Doughnut } from 'svelte-chartjs';
	import { Chart as ChartJS, Title, Tooltip, Legend, ArcElement } from 'chart.js';

	ChartJS.register(Title, Tooltip, Legend, ArcElement);

	interface SourceMixSlice {
		source: string;
		count: number;
	}

	interface Props {
		slices: SourceMixSlice[];
	}

	let { slices }: Props = $props();

	const palette: Record<string, string> = {
		manual: '#a0a0a0',
		agent: '#00d4ff'
	};

	const labelMap: Record<string, string> = {
		manual: 'Manual (UI)',
		agent: 'Agent-mediated'
	};

	let chartData = $derived({
		labels: slices.map((s) => labelMap[s.source] ?? s.source),
		datasets: [
			{
				data: slices.map((s) => s.count),
				backgroundColor: slices.map((s) => palette[s.source] ?? '#666'),
				borderColor: 'var(--color-tron-bg-primary)',
				borderWidth: 2
			}
		]
	});

	let total = $derived(slices.reduce((acc, s) => acc + s.count, 0));

	const chartOptions = {
		responsive: true,
		maintainAspectRatio: false,
		plugins: {
			legend: { position: 'right' as const, labels: { color: '#e0e0e0', boxWidth: 12, font: { size: 10 } } },
			tooltip: {}
		}
	};
</script>

<div class="tron-card p-4">
	<h3 class="tron-text-primary mb-3 text-sm font-bold">Manual vs Agent ({total})</h3>
	{#if slices.length === 0}
		<p class="tron-text-muted text-xs">No tasks created in range.</p>
	{:else}
		<div style="height: 200px;">
			<Doughnut data={chartData} options={chartOptions} />
		</div>
	{/if}
</div>
