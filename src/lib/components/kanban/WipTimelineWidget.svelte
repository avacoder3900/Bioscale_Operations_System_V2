<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';

	interface WipSegment {
		taskId: string;
		taskTitle: string;
		projectColor: string;
		startBucket: number;
		endBucket: number;
		startUtc: string;
		endUtc: string | null;
	}

	interface WipLane {
		laneIndex: number;
		isOverflow: boolean;
		segments: WipSegment[];
	}

	interface WipTimelinePerson {
		userId: string;
		username: string;
		wipLimit: number;
		lanes: WipLane[];
	}

	interface WipTimelineData {
		day: string;
		people: WipTimelinePerson[];
	}

	interface Props {
		data: WipTimelineData;
	}

	let { data }: Props = $props();

	// Day tabs — show current week (Sunday-anchored) in the viewer's local time.
	// Using UTC drifts the label by one day for CT users between 7pm and midnight.
	let weekDays = $derived.by(() => {
		const today = new Date();
		const dow = today.getDay(); // 0=Sun..6=Sat, local
		const sunday = new Date(today);
		sunday.setDate(today.getDate() - dow);
		const labels = ['S', 'M', 'T', 'W', 'R', 'F', 'S'];
		return labels.map((l, i) => {
			const d = new Date(sunday);
			d.setDate(sunday.getDate() + i);
			const y = d.getFullYear();
			const m = String(d.getMonth() + 1).padStart(2, '0');
			const day = String(d.getDate()).padStart(2, '0');
			return { label: l, iso: `${y}-${m}-${day}` };
		});
	});

	function setDay(iso: string) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('day', iso);
		params.set('tz', String(new Date().getTimezoneOffset()));
		goto(`/kanban/analytics?${params.toString()}`, { replaceState: true, noScroll: true });
	}

	// Anchor the chart to the viewer's local timezone. The server otherwise
	// buckets against UTC midnight, which drifts segments by the tz offset —
	// at 3:32pm CT that puts bars in the ">6pm" overflow, visibly stretching
	// past the now-line. Runs as a $effect so it re-fires whenever the URL
	// loses the tz param (e.g. clicking the "Analytics" nav link while
	// already on this page strips the search string but doesn't remount).
	$effect(() => {
		if (typeof window === 'undefined') return;
		const current = $page.url.searchParams.get('tz');
		const wanted = String(new Date().getTimezoneOffset());
		if (current === wanted) return;
		const params = new URLSearchParams($page.url.searchParams);
		params.set('tz', wanted);
		goto(`/kanban/analytics?${params.toString()}`, { replaceState: true, noScroll: true });
	});

	// Pseudo-push refresh: poll a tiny watermark endpoint every 2s. When the
	// most-recent kanban_task updatedAt advances past what we've seen, pull
	// fresh data. Also refresh whenever the tab regains focus. The 30s safety
	// poll covers edge cases where mtime doesn't update for some reason.
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let mtimeTimer: ReturnType<typeof setInterval> | null = null;
	let lastMtime = $state(0);

	async function checkMtime() {
		if (document.hidden) return;
		try {
			const res = await fetch('/api/kanban/wip-mtime');
			if (!res.ok) return;
			const { mtime } = (await res.json()) as { mtime: number };
			if (mtime > lastMtime) {
				lastMtime = mtime;
				invalidateAll();
			}
		} catch {
			// Network blip — next tick will retry.
		}
	}

	function handleVisibility() {
		if (!document.hidden) {
			// Returned to tab — force a refresh immediately.
			checkMtime();
			invalidateAll();
		}
	}

	onMount(() => {
		// Seed lastMtime so the first poll doesn't trigger a redundant refresh.
		checkMtime();
		mtimeTimer = setInterval(checkMtime, 2_000);
		pollTimer = setInterval(() => {
			if (!document.hidden) invalidateAll();
		}, 30_000);
		document.addEventListener('visibilitychange', handleVisibility);
	});
	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (mtimeTimer) clearInterval(mtimeTimer);
		document.removeEventListener('visibilitychange', handleVisibility);
	});

	// Build a lookup from bucket index → segment for each lane.
	function cellsForLane(lane: WipLane) {
		const cells: (WipSegment | null)[] = new Array(46).fill(null);
		for (const seg of lane.segments) {
			const end = Math.min(46, seg.endBucket);
			for (let i = Math.max(0, seg.startBucket); i < end; i++) {
				cells[i] = seg;
			}
		}
		return cells;
	}

	// Pre-built bucket labels: 0=before, 1..44=7:00..17:45, 45=after.
	// 12-hour format with am/pm suffix; only the on-the-hour cells get labeled.
	function hourLabel(h24: number): string {
		const ampm = h24 < 12 ? 'a' : 'p';
		const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
		return `${h12}${ampm}`;
	}
	const headerLabels: string[] = (() => {
		const arr: string[] = ['<7a'];
		for (let i = 0; i < 44; i++) {
			const totalMin = 7 * 60 + i * 15;
			const h = Math.floor(totalMin / 60);
			const m = totalMin % 60;
			arr.push(m === 0 ? hourLabel(h) : '');
		}
		arr.push('>6p');
		return arr;
	})();

	function formatRange(seg: WipSegment): string {
		const start = new Date(seg.startUtc).toLocaleString();
		const end = seg.endUtc ? new Date(seg.endUtc).toLocaleString() : 'still in WIP';
		return `${start} → ${end}`;
	}

	/** Format YYYY-MM-DD → MM/DD/YY for the date label next to day tabs. */
	function formatDayShort(iso: string): string {
		const [y, m, d] = iso.split('-');
		return `${m}/${d}/${y.slice(2)}`;
	}

	/** Today in the browser's local timezone, YYYY-MM-DD. Used to gate the "now" line. */
	function todayLocal(): string {
		const d = new Date();
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	let isToday = $derived(data.day === todayLocal());

	// Position of the "now" line in pixels from the left edge of the inner grid.
	// Recomputed every minute (and on mount) so the line marches across the day.
	const LABEL_WIDTH_PX = 128; // matches `w-32` on the person-label column
	const OVERFLOW_CELL_PX = 32;
	const REGULAR_CELL_PX = 18;

	function computeNowLeftPx(): number {
		const n = new Date();
		const minutesFromMidnight = n.getHours() * 60 + n.getMinutes();
		const sevenAm = 7 * 60;
		const sixPm = 18 * 60;

		// Before 7 AM — position within the "<7a" overflow cell
		if (minutesFromMidnight < sevenAm) {
			const frac = minutesFromMidnight / sevenAm;
			return LABEL_WIDTH_PX + frac * OVERFLOW_CELL_PX;
		}
		// After 6 PM — position within the ">6p" overflow cell
		if (minutesFromMidnight >= sixPm) {
			const overflowSpan = 24 * 60 - sixPm;
			const frac = Math.min(1, (minutesFromMidnight - sixPm) / overflowSpan);
			return LABEL_WIDTH_PX + OVERFLOW_CELL_PX + 44 * REGULAR_CELL_PX + frac * OVERFLOW_CELL_PX;
		}
		// In the regular 7am-6pm window
		const minutesFrom7 = minutesFromMidnight - sevenAm;
		return LABEL_WIDTH_PX + OVERFLOW_CELL_PX + (minutesFrom7 / 15) * REGULAR_CELL_PX;
	}

	let nowLeftPx = $state(0);
	let nowTickTimer: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		nowLeftPx = computeNowLeftPx();
		nowTickTimer = setInterval(() => {
			nowLeftPx = computeNowLeftPx();
		}, 60_000); // every minute
	});
	onDestroy(() => {
		if (nowTickTimer) clearInterval(nowTickTimer);
	});

	/**
	 * Task titles for the right-side label column. Only currently-active WIP
	 * tasks (endUtc === null) appear here — ended-today tasks still paint
	 * their cells but their title is reachable via the cell hover tooltip.
	 * Keeps the column from accumulating stale completed work across the day.
	 */
	function laneTasks(lane: WipLane): WipSegment[] {
		const seen = new Set<string>();
		const out: WipSegment[] = [];
		for (const seg of lane.segments) {
			if (seg.endUtc !== null) continue;
			if (seen.has(seg.taskId)) continue;
			seen.add(seg.taskId);
			out.push(seg);
		}
		return out;
	}
</script>

<div class="tron-card p-4">
	<div class="mb-3 flex items-center justify-between">
		<h3 class="tron-text-primary text-sm font-bold">Daily WIP Timeline</h3>
		<div class="flex items-center gap-3">
			<span class="text-xs font-mono tron-text-muted" title={data.day}>
				{formatDayShort(data.day)}
			</span>
			<div class="flex gap-1">
				{#each weekDays as d}
					{@const active = data.day === d.iso}
					<button
						type="button"
						class="h-7 w-7 rounded text-[10px] font-bold transition-all {active
							? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
							: 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
						title={d.iso}
						onclick={() => setDay(d.iso)}
					>
						{d.label}
					</button>
				{/each}
			</div>
		</div>
	</div>

	{#if data.people.length === 0}
		<p class="tron-text-muted py-8 text-center text-xs">
			No WIP activity on {data.day}.
		</p>
	{:else}
		<div class="overflow-x-auto">
			<div class="relative inline-block min-w-full">
				{#if isToday}
					<!-- "Now" line — vertical marker at the current time, only on today's chart. -->
					<div
						class="pointer-events-none absolute top-6 bottom-0 w-px"
						style="left: {nowLeftPx}px; background: var(--color-tron-cyan); z-index: 5; box-shadow: 0 0 6px var(--color-tron-cyan);"
						title="Now"
					></div>
				{/if}
				<!-- Header row -->
				<div class="flex border-b border-[var(--color-tron-border)] pb-1 text-[9px] text-[var(--color-tron-text-secondary)]">
					<div class="sticky left-0 w-32 shrink-0 pr-2 text-right">time →</div>
					{#each headerLabels as label, i}
						{@const isOverflow = i === 0 || i === 45}
						<div
							class="shrink-0 text-center"
							style="width: {isOverflow ? '32px' : '18px'};"
						>
							{label}
						</div>
					{/each}
				</div>

				<!-- Person rows -->
				{#each data.people as person (person.userId)}
					{@const totalLanes = person.lanes.length || person.wipLimit}
					{@const lanesToShow = person.lanes.length > 0
						? person.lanes
						: Array.from({ length: person.wipLimit }, (_, i) => ({ laneIndex: i, isOverflow: false, segments: [] }))}

					<div class="border-b border-[var(--color-tron-border)]/50 py-1">
						<div class="flex items-start">
							<!-- Label -->
							<div class="sticky left-0 w-32 shrink-0 pr-2 text-right">
								<div class="text-xs font-bold tron-text-primary">{person.username}</div>
								<div class="tron-text-muted text-[10px]">limit {person.wipLimit}</div>
							</div>

							<!-- Lanes stack -->
							<div class="flex-1">
								{#each lanesToShow as lane (lane.laneIndex)}
									{@const cells = cellsForLane(lane)}
									{@const titles = laneTasks(lane)}
									<div class="mb-0.5 flex items-center gap-3">
										<!-- Cell grid -->
										<div
											class="flex"
											class:opacity-100={!lane.isOverflow}
										>
											{#each cells as cell, i}
												{@const isOverflowCell = i === 0 || i === 45}
												<a
													href={cell ? `/kanban/task/${cell.taskId}` : undefined}
													title={cell ? `${cell.taskTitle}\n${formatRange(cell)}` : ''}
													class="block h-5 shrink-0 border-r border-[var(--color-tron-bg-primary)] transition-opacity hover:opacity-80"
													style="width: {isOverflowCell ? '32px' : '18px'}; background: {cell
														? cell.projectColor
														: 'rgba(160,160,160,0.08)'}; {lane.isOverflow && cell ? 'outline: 1px solid var(--color-tron-red);' : ''}"
												></a>
											{/each}
										</div>

										<!-- Task titles to the right of the cells -->
										<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
											{#each titles as seg (seg.taskId)}
												<a
													href="/kanban/task/{seg.taskId}"
													class="inline-flex items-center gap-1 text-[10px] hover:underline"
													style="color: {seg.projectColor};"
													title={seg.taskTitle}
												>
													<span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background: {seg.projectColor};"></span>
													<span class="max-w-[240px] truncate">{seg.taskTitle}</span>
												</a>
											{/each}
											{#if titles.length === 0}
												<span class="tron-text-muted text-[9px] italic opacity-50">— empty slot —</span>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
