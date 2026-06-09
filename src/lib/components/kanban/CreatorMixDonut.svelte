<script lang="ts">
	import { Doughnut } from 'svelte-chartjs';
	import { Chart as ChartJS, Title, Tooltip, Legend, ArcElement } from 'chart.js';

	ChartJS.register(Title, Tooltip, Legend, ArcElement);

	interface CreatorMixSlice {
		userId: string;
		username: string;
		count: number;
	}

	interface Props {
		slices: CreatorMixSlice[];
	}

	let { slices }: Props = $props();

	// Stable rotating palette — assigns each creator a distinct color by index.
	const palette = [
		'#00d4ff', '#ff6600', '#00ff88', '#a855f7', '#ff3366',
		'#f59e0b', '#3b82f6', '#22d3ee', '#fb7185', '#84cc16'
	];

	let chartData = $derived({
		labels: slices.map((s) => s.username),
		datasets: [
			{
				data: slices.map((s) => s.count),
				backgroundColor: slices.map((_, i) => palette[i % palette.length]),
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
	<h3 class="tron-text-primary mb-3 text-sm font-bold">Created by ({total})</h3>
	{#if slices.length === 0}
		<p class="tron-text-muted text-xs">No tasks created in range.</p>
	{:else}
		<div style="height: 200px;">
			<Doughnut data={chartData} options={chartOptions} />
		</div>
	{/if}
</div>
