<script lang="ts">
	/**
	 * KB2-29 — Roadmap: countdown headers, the must-start list (daily driver),
	 * and the chronological timeline (weekly review). Past of today's line =
	 * fact (solid bars from real stamps); future = math (hollow/dashed bars
	 * from the KB2-28 backward pass). No bar is editable — dates are outputs;
	 * you change them by changing reality (links, estimates, scope).
	 */
	import { tagColor } from '$lib/shared/tag-color';

	let { data } = $props();

	const DAY_MS = 24 * 60 * 60 * 1000;
	const today = new Date(new Date().setHours(0, 0, 0, 0));

	type FutureSpan = {
		id: string; trackingNumber: string | null; title: string; status: string;
		lane: string; start: Date; end: Date; critical: boolean; late: boolean;
		milestone: string; estimateSource: string;
	};

	// ---- future spans: dedupe tasks appearing in several milestone subgraphs
	// (keep the min-slack occurrence — the binding constraint).
	const futureSpans: FutureSpan[] = $derived.by(() => {
		const best = new Map<string, { slack: number; span: FutureSpan }>();
		for (const m of data.roadmap.milestones) {
			for (const t of m.tasks) {
				if (t.done || t.itemType === 'milestone' || !t.earlyStart || !t.earlyFinish) continue;
				const slack = t.slackDays ?? 9999;
				const prev = best.get(t.id);
				if (prev && prev.slack <= slack) continue;
				best.set(t.id, {
					slack,
					span: {
						id: t.id, trackingNumber: t.trackingNumber, title: t.title, status: t.status,
						lane: (t.tags ?? [])[0] ?? 'untagged',
						start: new Date(t.earlyStart), end: new Date(t.earlyFinish),
						critical: t.onCriticalChain, late: t.late,
						milestone: m.title, estimateSource: t.estimateSource
					}
				});
			}
		}
		return [...best.values()].map((x) => x.span);
	});

	const pastSpans = $derived(
		data.pastSpans.map((s: any) => ({
			...s,
			start: new Date(s.start),
			end: s.end ? new Date(s.end) : today
		}))
	);

	const milestoneMarks = $derived(
		data.roadmap.milestones.map((m: any) => ({
			id: m.id, title: m.title, due: new Date(m.dueDate),
			projected: new Date(m.projectedFinish), feasible: m.feasible
		}))
	);

	// ---- time domain
	const domainStart = $derived.by(() => {
		const min = Math.min(
			today.getTime() - 28 * DAY_MS,
			...pastSpans.map((s: any) => s.start.getTime())
		);
		return new Date(min - 3 * DAY_MS);
	});
	const domainEnd = $derived.by(() => {
		const max = Math.max(
			today.getTime() + 28 * DAY_MS,
			...futureSpans.map((s) => s.end.getTime()),
			...milestoneMarks.map((m: any) => m.due.getTime()),
			...milestoneMarks.map((m: any) => m.projected.getTime())
		);
		return new Date(max + 7 * DAY_MS);
	});

	// ---- layout
	const AXIS_H = 34;
	const LANE_PAD = 6;
	const BAR_H = 14;
	const BAR_GAP = 4;
	const LABEL_W = 130;
	const CHART_W = 1150;

	const px = $derived((d: Date) =>
		LABEL_W + ((d.getTime() - domainStart.getTime()) / (domainEnd.getTime() - domainStart.getTime())) * (CHART_W - LABEL_W)
	);

	// lanes: union of past+future lanes, ordered by activity volume
	const lanes = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const s of [...pastSpans, ...futureSpans]) counts.set(s.lane, (counts.get(s.lane) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([lane]) => lane);
	});

	// pack spans into sub-rows per lane (greedy, no overlap)
	type Placed = { span: any; kind: 'past' | 'future'; row: number };
	const laneLayouts = $derived.by(() => {
		const out: { lane: string; y: number; height: number; placed: Placed[] }[] = [];
		let y = AXIS_H;
		for (const lane of lanes) {
			const spans = [
				...pastSpans.filter((s: any) => s.lane === lane).map((span: any) => ({ span, kind: 'past' as const })),
				...futureSpans.filter((s) => s.lane === lane).map((span) => ({ span, kind: 'future' as const }))
			].sort((a, b) => a.span.start.getTime() - b.span.start.getTime());
			const rowEnds: number[] = [];
			const placed: Placed[] = [];
			for (const item of spans) {
				let row = rowEnds.findIndex((e) => e <= item.span.start.getTime());
				if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
				rowEnds[row] = item.span.end.getTime() + DAY_MS;
				placed.push({ ...item, row });
			}
			const height = LANE_PAD * 2 + Math.max(1, rowEnds.length) * (BAR_H + BAR_GAP);
			out.push({ lane, y, height, placed });
			y += height;
		}
		return { lanes: out, totalH: y + 8 };
	});

	// weekly gridlines (Mondays)
	const weekLines = $derived.by(() => {
		const out: { x: number; label: string }[] = [];
		const d = new Date(domainStart);
		d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); // next Monday
		while (d <= domainEnd) {
			out.push({
				x: px(new Date(d)),
				label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
			});
			d.setDate(d.getDate() + 7);
		}
		return out;
	});

	const allMustStart = $derived(
		data.roadmap.milestones.flatMap((m: any) => m.mustStart)
			.sort((a: any, b: any) => (a.slackDays - b.slackDays) || (a.rank - b.rank))
	);

	const fmt = (isoDate: string) =>
		new Date(isoDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	const cal = $derived(data.roadmap.calibration);
</script>

<svelte:head><title>Roadmap — Kanban</title></svelte:head>

<div class="space-y-6">
	<!-- ======================= Milestone countdown headers ======================= -->
	{#if data.roadmap.milestones.length === 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 text-sm tron-text-muted">
			No dated milestones yet. Workshop the plan in the Claude app, file it with
			<span class="font-mono text-[var(--color-tron-cyan)]">kanban_file_plan</span>, then capture milestone tasks
			(<span class="font-mono">itemType: 'milestone'</span> + a due date) and wire their
			<span class="font-mono">blocked_by</span> chains. The backward pass takes it from there.
		</div>
	{:else}
		<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{#each data.roadmap.milestones as m (m.id)}
				<div class="rounded-lg border p-4 {m.feasible ? 'border-[var(--color-tron-border)]' : 'border-red-500/60'} bg-[var(--color-tron-bg-secondary)]">
					<div class="flex items-baseline justify-between gap-2">
						<a href="/kanban/task/{m.id}" class="tron-text-primary text-sm font-bold hover:underline">◆ {m.title}</a>
						<span class="text-xs font-mono tron-text-muted">{fmt(m.dueDate)}</span>
					</div>
					<div class="mt-2 flex items-center gap-4 text-xs">
						<span class="tron-text-muted">{m.daysLeft} wd left</span>
						<span class="tron-text-muted">{Math.round(m.chainPctByDays * 100)}% of chain done</span>
						<span class="font-bold {m.feasible ? (m.bufferDays <= 5 ? 'text-yellow-400' : 'text-green-400') : 'text-red-400'}">
							{m.feasible ? `${m.bufferDays} wd buffer` : `${-m.bufferDays} wd OVER`}
						</span>
					</div>
					<div class="mt-1 text-[11px] tron-text-muted">
						projected {fmt(m.projectedFinish)}{m.clampFinish && m.clampFinish > m.cpmFinish ? ' (capacity-limited)' : ''}
					</div>
					{#if !m.feasible}
						<div class="mt-2 rounded border border-red-500/40 bg-red-900/15 p-2 text-[11px] text-red-300">
							Not reachable at current pace — cut scope, add capacity, or move the date.
						</div>
					{/if}
					{#if m.cycleError}
						<div class="mt-2 rounded border border-yellow-500/40 bg-yellow-900/15 p-2 text-[11px] text-yellow-300">{m.cycleError}</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if data.roadmap.unscheduledMilestones.length}
		<div class="rounded border border-yellow-500/40 bg-yellow-900/10 p-2 text-xs text-yellow-300">
			Milestones without a due date (not scheduled):
			{#each data.roadmap.unscheduledMilestones as u, i (u.id)}
				{i > 0 ? ' · ' : ''}<a href="/kanban/task/{u.id}" class="underline">{u.title}</a>
			{/each}
		</div>
	{/if}

	<!-- ======================= Must-start (daily driver) ======================= -->
	{#if allMustStart.length}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="border-b border-[var(--color-tron-border)] px-4 py-2 text-sm font-bold tron-text-primary">
				Must start <span class="tron-text-muted font-normal">— unblocked, latest start now or near; slack ↑, Tier 1 rank breaks ties</span>
			</div>
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each allMustStart as t (t.id + t.milestoneId)}
					<div class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
						<span class="w-16 shrink-0 text-center rounded px-1.5 py-0.5 text-[11px] font-bold {t.late ? 'bg-red-900/40 text-red-300' : 'bg-yellow-900/30 text-yellow-300'}">
							{t.late ? 'LATE' : `${t.slackDays} wd`}
						</span>
						<a href="/kanban/task/{t.id}" class="tron-text-primary min-w-[200px] flex-1 font-medium hover:underline">
							{#if t.trackingNumber}<span class="font-mono text-xs tron-text-muted">{t.trackingNumber}</span>{/if}
							{t.title}
						</a>
						<span class="text-xs tron-text-muted">start by {fmt(t.lateStart)}</span>
						<span class="text-xs tron-text-muted">→ ◆ {t.milestoneTitle}</span>
						<span class="text-xs tron-text-muted">#{t.rank}</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- ======================= The timeline ======================= -->
	{#if laneLayouts.lanes.length}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
			<div class="mb-2 flex flex-wrap items-center gap-4 px-1 text-[11px] tron-text-muted">
				<span><span class="mr-1 inline-block h-2.5 w-4 rounded-sm bg-[var(--color-tron-cyan)] align-middle opacity-80"></span>past / in flight — fact</span>
				<span><span class="mr-1 inline-block h-2.5 w-4 rounded-sm border border-dashed border-[var(--color-tron-cyan)] align-middle"></span>scheduled — derived, not a commitment</span>
				<span><span class="mr-1 inline-block h-2.5 w-4 rounded-sm border border-red-400 align-middle"></span>critical chain</span>
				<span class="text-[var(--color-tron-cyan)]">◆ milestone</span>
			</div>
			<div class="overflow-x-auto">
				<svg width={CHART_W} height={laneLayouts.totalH + 10} class="min-w-full">
					<!-- week gridlines -->
					{#each weekLines as w (w.x)}
						<line x1={w.x} y1={AXIS_H - 6} x2={w.x} y2={laneLayouts.totalH} stroke="var(--color-tron-border)" stroke-width="1" />
						<text x={w.x + 3} y={AXIS_H - 10} class="fill-[var(--color-tron-text-secondary)]" font-size="9">{w.label}</text>
					{/each}
					<!-- lane bands + labels -->
					{#each laneLayouts.lanes as L, i (L.lane)}
						{#if i % 2 === 1}<rect x="0" y={L.y} width={CHART_W} height={L.height} fill="rgba(255,255,255,0.02)" />{/if}
						<text x="6" y={L.y + 16} font-size="11" font-weight="bold" fill={tagColor(L.lane)}>{L.lane}</text>
						{#each L.placed as p (p.kind + p.span.id)}
							{@const x1 = Math.max(LABEL_W, px(p.span.start))}
							{@const x2 = Math.max(x1 + 3, px(p.span.end))}
							{@const y = L.y + LANE_PAD + p.row * (BAR_H + BAR_GAP)}
							<g>
								{#if p.kind === 'past'}
									<rect x={x1} y={y} width={x2 - x1} height={BAR_H} rx="3" fill={tagColor(p.span.lane)} opacity={p.span.status === 'done' ? 0.75 : 0.5} />
									{#if p.span.status !== 'done'}
										<rect x={x1} y={y} width={x2 - x1} height={BAR_H} rx="3" fill="none" stroke={tagColor(p.span.lane)} stroke-width="1.5" />
									{/if}
								{:else}
									<rect x={x1} y={y} width={x2 - x1} height={BAR_H} rx="3" fill={tagColor(p.span.lane)} opacity="0.12" />
									<rect x={x1} y={y} width={x2 - x1} height={BAR_H} rx="3" fill="none"
										stroke={p.span.critical ? '#f87171' : tagColor(p.span.lane)}
										stroke-width={p.span.critical ? 2 : 1.2} stroke-dasharray={p.span.critical ? '' : '4 3'} />
									{#if p.span.late}<circle cx={x1 - 5} cy={y + BAR_H / 2} r="3" fill="#f87171" />{/if}
								{/if}
								<text x={x1 + 4} y={y + BAR_H - 3.5} font-size="9" fill="var(--color-tron-text)" opacity="0.95">
									{(p.span.trackingNumber ? p.span.trackingNumber + ' ' : '') + p.span.title}
								</text>
								<title>{p.span.title} — {p.kind === 'past' ? `actual (${p.span.status})` : `scheduled → ${p.span.milestone} (${p.span.estimateSource} estimate)`}</title>
							</g>
						{/each}
					{/each}
					<!-- today -->
					<line x1={px(today)} y1={AXIS_H - 6} x2={px(today)} y2={laneLayouts.totalH} stroke="var(--color-tron-cyan)" stroke-width="1.5" />
					<text x={px(today) + 3} y={AXIS_H + 6} font-size="9" fill="var(--color-tron-cyan)">today</text>
					<!-- milestone diamonds -->
					{#each milestoneMarks as m (m.id)}
						<line x1={px(m.due)} y1={AXIS_H - 6} x2={px(m.due)} y2={laneLayouts.totalH} stroke={m.feasible ? '#34d399' : '#f87171'} stroke-width="1" stroke-dasharray="5 4" />
						<path d="M {px(m.due)} 6 l 6 7 l -6 7 l -6 -7 Z" fill={m.feasible ? '#34d399' : '#f87171'} />
						<text x={px(m.due) + 9} y={16} font-size="10" font-weight="bold" fill={m.feasible ? '#34d399' : '#f87171'}>{m.title}</text>
					{/each}
				</svg>
			</div>
		</section>
	{/if}

	<!-- calibration footnote -->
	<p class="px-1 text-[11px] tron-text-muted">
		{#if cal.n > 0 && cal.medianActualOverEstimate}
			Estimate calibration: your explicit estimates run ~{cal.medianActualOverEstimate.toFixed(1)}× actual (n={cal.n}).
		{:else}
			No estimate-vs-actual history yet — calibration appears once estimated tasks complete.
		{/if}
		Velocity: {data.roadmap.velocityDaysPerWeek ? `${data.roadmap.velocityDaysPerWeek.toFixed(1)} estimate-days/week (8-wk mean)` : 'no history — capacity clamp off'}.
		Unsized default: {data.roadmap.medianCycleDays} wd.
		All future dates are computed, never stored — change them by changing links, estimates, or scope.
	</p>
</div>
