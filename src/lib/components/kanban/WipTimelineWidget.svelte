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

	// Day tabs — show current week (Sunday-anchored).
	let weekDays = $derived.by(() => {
		const today = new Date();
		const dow = today.getUTCDay(); // 0=Sun..6=Sat
		const sunday = new Date(today);
		sunday.setUTCDate(today.getUTCDate() - dow);
		const labels = ['S', 'M', 'T', 'W', 'R', 'F', 'S'];
		return labels.map((l, i) => {
			const d = new Date(sunday);
			d.setUTCDate(sunday.getUTCDate() + i);
			return { label: l, iso: d.toISOString().slice(0, 10) };
		});
	});

	function setDay(iso: string) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('day', iso);
		goto(`/kanban/analytics?${params.toString()}`, { replaceState: true, noScroll: true });
	}

	// Poll every 30s. Pause when tab hidden.
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	function startPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(() => {
			if (!document.hidden) invalidateAll();
		}, 30_000);
	}
	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}
	onMount(startPolling);
	onDestroy(stopPolling);

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
	const headerLabels: string[] = (() => {
		const arr: string[] = ['<7'];
		for (let i = 0; i < 44; i++) {
			const totalMin = 7 * 60 + i * 15;
			const h = Math.floor(totalMin / 60);
			const m = totalMin % 60;
			arr.push(m === 0 ? `${h}` : '');
		}
		arr.push('>6');
		return arr;
	})();

	function formatRange(seg: WipSegment): string {
		const start = new Date(seg.startUtc).toLocaleString();
		const end = seg.endUtc ? new Date(seg.endUtc).toLocaleString() : 'still in WIP';
		return `${start} → ${end}`;
	}
</script>

<div class="tron-card p-4">
	<div class="mb-3 flex items-center justify-between">
		<h3 class="tron-text-primary text-sm font-bold">Daily WIP Timeline</h3>
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

	{#if data.people.length === 0}
		<p class="tron-text-muted py-8 text-center text-xs">
			No WIP activity on {data.day}.
		</p>
	{:else}
		<div class="overflow-x-auto">
			<div class="inline-block min-w-full">
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
									<div
										class="mb-0.5 flex"
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
								{/each}
							</div>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
