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

	import { STATUS_META, type KanbanStatus } from '$lib/shared/kanban-status';

	type CfdPoint = { date: string } & Partial<Record<KanbanStatus, number>>;

	interface Props {
		points: CfdPoint[];
		title?: string;
		/** Which status bands to stack; defaults to all. Order here is ignored — BAND_ORDER wins. */
		statuses?: readonly KanbanStatus[];
	}

	let { points, title = 'Cumulative Flow Diagram', statuses }: Props = $props();

	// Stack order bottom → top: done at bottom (banked work), committed work
	// in the middle, upstream inventory (captured et al.) at the top so new
	// scope pushes the top edge up.
	const BAND_ORDER: KanbanStatus[] = [
		'done',
		'review',
		'wip',
		'blocked',
		'waiting',
		'ready',
		'processed',
		'captured',
		'icebox',
		'declined'
	];
	let bands = $derived(
		BAND_ORDER.filter((key) => !statuses || statuses.includes(key)).map((key) => ({
			key,
			label: STATUS_META[key].label,
			color: STATUS_META[key].color
		}))
	);

	let chartData = $derived({
		labels: points.map((p) => p.date),
		datasets: bands.map((b) => ({
			label: b.label,
			data: points.map((p) => p[b.key] ?? 0),
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
	<h3 class="tron-text-primary mb-3 text-sm font-bold">{title}</h3>
	{#if points.length === 0}
		<p class="tron-text-muted text-xs">Not enough data to render.</p>
	{:else}
		<div style="height: 360px;">
			<Line data={chartData} options={chartOptions} />
		</div>
	{/if}
</div>
