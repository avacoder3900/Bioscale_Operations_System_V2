<script lang="ts">
	import { Scatter } from 'svelte-chartjs';
	import {
		Chart as ChartJS,
		Title,
		Tooltip,
		Legend,
		PointElement,
		LinearScale,
		TimeScale,
		CategoryScale
	} from 'chart.js';

	ChartJS.register(Title, Tooltip, Legend, PointElement, LinearScale, TimeScale, CategoryScale);

	interface CycleScatterPoint {
		taskId: string;
		title: string;
		completedAt: string;
		cycleTimeDays: number;
		color: string;
	}

	interface Props {
		block: {
			points: CycleScatterPoint[];
			p50: number | null;
			p85: number | null;
			p95: number | null;
		};
	}

	let { block }: Props = $props();

	let chartData = $derived({
		datasets: [
			{
				label: 'Tasks',
				data: block.points.map((p) => ({
					x: new Date(p.completedAt).getTime(),
					y: p.cycleTimeDays,
					raw: p
				})),
				backgroundColor: block.points.map((p) => p.color),
				borderColor: '#000',
				pointRadius: 4,
				pointHoverRadius: 6
			}
		]
	});

	let chartOptions = $derived({
		responsive: true,
		maintainAspectRatio: false,
		scales: {
			x: {
				type: 'linear' as const,
				ticks: {
					color: '#a0a0a0',
					callback: (val: any) => new Date(val).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
				},
				grid: { color: 'rgba(160,160,160,0.1)' }
			},
			y: {
				beginAtZero: true,
				title: { display: true, text: 'Cycle time (days)', color: '#a0a0a0' },
				ticks: { color: '#a0a0a0' },
				grid: { color: 'rgba(160,160,160,0.1)' }
			}
		},
		plugins: {
			legend: { display: false },
			tooltip: {
				callbacks: {
					label: (ctx: any) => {
						const raw = ctx.raw?.raw;
						if (!raw) return '';
						return `${raw.title} — ${raw.cycleTimeDays}d`;
					}
				}
			}
		}
	});
</script>

<div class="tron-card p-4">
	<div class="mb-3 flex items-baseline justify-between">
		<h3 class="tron-text-primary text-sm font-bold">Cycle time scatter</h3>
		<div class="tron-text-muted flex gap-3 text-[10px]">
			{#if block.p50 !== null}<span>p50: {Math.round(block.p50 * 10) / 10}d</span>{/if}
			{#if block.p85 !== null}<span>p85: {Math.round(block.p85 * 10) / 10}d</span>{/if}
			{#if block.p95 !== null}<span>p95: {Math.round(block.p95 * 10) / 10}d</span>{/if}
		</div>
	</div>
	{#if block.points.length === 0}
		<p class="tron-text-muted text-xs">No completions in range.</p>
	{:else}
		<div style="height: 260px;">
			<Scatter data={chartData} options={chartOptions} />
		</div>
	{/if}
</div>
