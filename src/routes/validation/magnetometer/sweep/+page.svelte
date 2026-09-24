<script lang="ts">
	import SweepFieldChart from './SweepFieldChart.svelte';

	interface SessionListItem {
		_id: string;
		spuUdi?: string | null;
		startedAt?: string | null;
		status?: string | null;
	}

	interface SessionMeta {
		_id: string;
		spuId?: string | null;
		spuUdi?: string | null;
		startedAt?: string | null;
		completedAt?: string | null;
	}

	interface Profile {
		peakY?: number | null;
		peakMag?: number | null;
		travelLimited?: boolean | null;
		edge?: 'none' | 'distal' | 'proximal' | null;
		method?: 'peak' | 'slope' | null;
		[key: string]: unknown;
	}

	interface Point {
		y: number;
		bx?: number | null;
		by?: number | null;
		bz?: number | null;
		mag?: number | null;
	}

	interface MagResults {
		wells?: Record<string, Record<string, Profile>> | null;
		wellNumbers?: (number | string)[] | null;
		channels?: string[] | null;
		rowsIngested?: number | null;
		rowsReported?: number | null;
		goodReported?: number | null;
		durationMs?: number | null;
	}

	interface Props {
		data: {
			sessions?: SessionListItem[] | null;
			selected?: SessionMeta | null;
			magResults?: MagResults | null;
			series?: Record<string, Record<string, Point[]>> | null;
		};
	}

	let { data }: Props = $props();

	const sessions = $derived(data.sessions ?? []);
	const session = $derived(data.selected ?? null);
	const magResults = $derived(data.magResults ?? null);

	/** Object keys survive JSON as strings, so every lookup goes through String(). */
	const wellNumbers = $derived<string[]>(
		(magResults?.wellNumbers ?? []).map((w) => String(w)).filter((w) => w.length > 0)
	);

	const channels = $derived<string[]>(magResults?.channels ?? []);

	function profileFor(well: string, channel: string): Profile | null {
		return magResults?.wells?.[well]?.[channel] ?? null;
	}

	function seriesFor(well: string, channel: string): Point[] {
		return data.series?.[well]?.[channel] ?? [];
	}

	/** Channels on this well that are characterised by slope rather than peak. */
	function travelLimitedChannels(well: string): string[] {
		return channels.filter((c) => {
			const p = profileFor(well, c);
			return p?.method === 'slope' || p?.travelLimited === true;
		});
	}

	function fmtDateTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
	}

	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
	}

	function fmtCount(v: number | null | undefined): string {
		return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '—';
	}

	function fmtDuration(ms: number | null | undefined): string {
		if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
		if (ms < 1000) return Math.round(ms) + ' ms';
		const s = ms / 1000;
		if (s < 60) return s.toFixed(1) + ' s';
		const m = Math.floor(s / 60);
		return m + 'm ' + Math.round(s - m * 60) + 's';
	}

	const stats = $derived([
		{ label: 'Rows ingested', value: fmtCount(magResults?.rowsIngested) },
		{ label: 'Rows reported', value: fmtCount(magResults?.rowsReported) },
		{ label: 'Good reported', value: fmtCount(magResults?.goodReported) },
		{ label: 'Duration', value: fmtDuration(magResults?.durationMs) }
	]);

	const hasGrid = $derived(wellNumbers.length > 0 && channels.length > 0);
</script>

<svelte:head>
	<title>Magnetometer Sweep Profiles</title>
</svelte:head>

<div class="space-y-6">
	<a
		href="/validation/magnetometer"
		class="inline-flex items-center gap-2 text-sm text-slate-400 transition-colors hover:text-[var(--color-tron-cyan)] dark:text-slate-400"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
		</svg>
		Back to Magnetometer Tests
	</a>

	<div>
		<h1 class="text-2xl font-bold text-slate-100 dark:text-slate-100">Sweep Profiles</h1>
		<p class="mt-1 text-sm text-slate-400 dark:text-slate-400">
			Field components and magnitude across stage travel, one trace per well per channel.
		</p>
	</div>

	<!-- Session picker -->
	<section class="rounded-lg border border-slate-700/60 bg-slate-900/40 p-4">
		<h2 class="mb-3 text-sm font-semibold text-slate-200 dark:text-slate-200">Session</h2>
		{#if sessions.length === 0}
			<p class="text-sm text-slate-400 dark:text-slate-400">No sweep sessions available.</p>
		{:else}
			<div class="flex flex-wrap gap-2">
				{#each sessions as s (s._id)}
					{@const active = session?._id === s._id}
					<a
						href="?sessionId={encodeURIComponent(s._id)}"
						aria-current={active ? 'page' : undefined}
						class="rounded border px-3 py-2 text-xs transition-colors {active
							? 'border-[var(--color-tron-cyan)] bg-[rgba(0,212,255,0.12)] text-slate-100'
							: 'border-slate-700/60 text-slate-300 hover:border-slate-500 hover:text-slate-100'}"
					>
						<span class="block font-semibold">{s.spuUdi ?? s._id}</span>
						<span class="block text-slate-400 dark:text-slate-400">
							{fmtDate(s.startedAt)}{s.status ? ' · ' + s.status : ''}
						</span>
					</a>
				{/each}
			</div>
		{/if}
	</section>

	{#if !session}
		<p class="rounded-lg border border-slate-700/60 bg-slate-900/40 p-6 text-sm text-slate-400">
			Select a session above to view its sweep profiles.
		</p>
	{:else}
		<!-- Session header -->
		<section class="rounded-lg border border-slate-700/60 bg-slate-900/40 p-4">
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h2 class="text-lg font-bold text-slate-100 dark:text-slate-100">
					{session.spuUdi ?? session.spuId ?? session._id}
				</h2>
				<p class="text-xs text-slate-400 dark:text-slate-400">
					Started {fmtDateTime(session.startedAt)} · Completed {fmtDateTime(session.completedAt)}
				</p>
			</div>

			<dl class="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
				{#each stats as stat (stat.label)}
					<div>
						<dt class="text-xs text-slate-400 dark:text-slate-400">{stat.label}</dt>
						<dd class="mt-0.5 text-xl font-semibold tabular-nums text-slate-100 dark:text-slate-100">
							{stat.value}
						</dd>
					</div>
				{/each}
			</dl>
		</section>

		<a
			href="/validation/magnetometer/sweep/export?sessionId={encodeURIComponent(session._id)}"
			class="inline-block rounded border border-slate-700/60 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-slate-100"
		>
			Export this sweep (.xlsx)
		</a>

		{#if !hasGrid}
			<p class="rounded-lg border border-slate-700/60 bg-slate-900/40 p-6 text-sm text-slate-400">
				No per-well sweep profiles were recorded for this session.
			</p>
		{:else}
			{#each wellNumbers as well (well)}
				{@const limited = travelLimitedChannels(well)}
				<section class="space-y-3">
					<div class="flex flex-wrap items-center gap-3 border-b border-slate-700/60 pb-2">
						<h3 class="text-base font-bold text-slate-100 dark:text-slate-100">Well {well}</h3>
						{#if limited.length > 0}
							<span
								class="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300 dark:text-amber-300"
							>
								Travel-limited · characterised by rising slope ({limited.join(', ')})
							</span>
						{/if}
					</div>

					<div class="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
						{#each channels as channel (channel)}
							<SweepFieldChart
								{channel}
								series={seriesFor(well, channel)}
								profile={profileFor(well, channel)}
							/>
						{/each}
					</div>
				</section>
			{/each}
		{/if}
	{/if}
</div>
