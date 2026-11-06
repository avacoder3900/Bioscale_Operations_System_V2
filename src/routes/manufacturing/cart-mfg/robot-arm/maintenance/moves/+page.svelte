<script lang="ts">
	/**
	 * Maintenance → Movement Log (2026-11-06): every command BIMS sent that
	 * moved the arm, per servo, newest first, with how many times each servo
	 * moved and turned back in the window (shapes in $lib/robot-arm/move-log).
	 *
	 * Opentrons rows (2026-11-06): every command the arm line's OT-2 ran, with
	 * the robot's own start, end and seconds, on the same timeline as the arm;
	 * Link rows (2026-11-06): every BIMS → OT-2 hop, through the arm Pi's cable
	 * or the queue, with the Pi's and the robot's ms.
	 * Timing sets the three side by side ($lib/robot-arm/ot2-move-log).
	 *
	 * Filters (2026-11-06): device, a broad type group or one exact type
	 * ($lib/robot-arm/move-types), time, servo, and the newest N rows (100
	 * unless changed; All for every row), with "Showing N Of Total".
	 *
	 * Servo readings (2026-11-06): a Reading Before and Reading After row
	 * around each arm move; OT-2 home and rail lights outside a run.
	 *
	 * Frames (2026-11-06): a play's row opens to every frame the Pi was given
	 * (time, each servo's goal, fire steps), read on demand from ./frames.
	 */
	import { DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';
	import { goto } from '$app/navigation';
	import { kindTitle, type PlayFrames } from '$lib/robot-arm/move-log';
	import { MOVE_GROUPS, groupOfKind, moveGroup } from '$lib/robot-arm/move-types';

	let { data } = $props();

	let logHidden = $state(false);

	/** Opened plays: their frames, or the read's error. */
	let openFrames = $state<Record<string, { frames: PlayFrames | null; error: string | null; loading: boolean }>>({});

	async function toggleFrames(id: string) {
		if (openFrames[id]) {
			delete openFrames[id];
			return;
		}
		openFrames[id] = { frames: null, error: null, loading: true };
		try {
			const res = await fetch(`${BASE}/frames?id=${encodeURIComponent(id)}`);
			if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
			const body = (await res.json()) as { frames: PlayFrames | null };
			if (openFrames[id]) openFrames[id] = { frames: body.frames, error: body.frames ? null : 'No Frames Kept', loading: false };
		} catch (err) {
			if (openFrames[id]) openFrames[id] = { frames: null, error: err instanceof Error ? err.message : String(err), loading: false };
		}
	}

	const fireAt = (f: PlayFrames, t: number) => f.fires.filter((x) => x.t === t).map((x) => `${x.label} ${x.ms} ms`).join(', ');

	const BASE = '/manufacturing/cart-mfg/robot-arm/maintenance/moves';
	const windows = [
		{ minutes: 60, title: 'Last Hour' },
		{ minutes: 1440, title: 'Last 24 Hours' },
		{ minutes: 10080, title: 'Last 7 Days' },
		{ minutes: 0, title: 'All Time' }
	];
	const devices: { device: 'arm' | 'ot2' | 'link' | null; title: string }[] = [
		{ device: null, title: 'All' },
		{ device: 'arm', title: 'Robot Arm' },
		{ device: 'ot2', title: 'Opentron' },
		{ device: 'link', title: 'Link' }
	];
	const DEVICE_TITLES = { arm: 'Robot Arm', ot2: 'Opentron', link: 'Link' } as const;
	const servos = [1, 2, 3, 4, 5, 6];

	const jointTitle = (sid: number) =>
		(DEFAULT_JOINT_NAMES[sid - 1] ?? '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

	interface View {
		minutes: number;
		servo: number | null;
		device: 'arm' | 'ot2' | 'link' | null;
		group: string | null;
		kind: string | null;
		count: number | 'all';
	}

	function href(change: Partial<View>): string {
		const v: View = { minutes: data.minutes, servo: data.servo, device: data.device, group: data.group, kind: data.kind, count: data.count, ...change };
		const q = new URLSearchParams();
		if (v.minutes) q.set('minutes', String(v.minutes));
		if (v.servo) q.set('servo', String(v.servo));
		else if (v.device) q.set('device', v.device);
		if (v.group) q.set('group', v.group);
		if (v.kind) q.set('kind', v.kind);
		if (v.count !== 100) q.set('n', String(v.count));
		const s = q.toString();
		return s ? `${BASE}?${s}` : BASE;
	}

	/** A device keeps the type only when the type is that device's. */
	function deviceHref(device: 'arm' | 'ot2' | 'link' | null): string {
		const g = moveGroup(data.group);
		const keepGroup = !!device && g?.device === device;
		const keepKind = !!device && !!data.kind && data.kinds.some((k) => k.device === device && k.kind === data.kind);
		return href({ device, servo: null, group: keepGroup ? data.group : null, kind: keepKind ? data.kind : null });
	}

	// Only groups the log has rows for (and the one picked).
	const groupsLogged = $derived(new Set(data.kinds.map((k) => groupOfKind(k.device, k.kind)?.id)));
	const groupsShown = $derived(
		MOVE_GROUPS.filter((g) => (!data.device || g.device === data.device) && (groupsLogged.has(g.id) || g.id === data.group))
	);
	const kindsShown = $derived(
		data.kinds
			.filter((k) => (!data.device || k.device === data.device) && (!data.group || groupOfKind(k.device, k.kind)?.id === data.group))
			.sort((a, b) => a.device.localeCompare(b.device) || kindTitle(a.kind).localeCompare(kindTitle(b.kind)))
	);
	const kindDevices = $derived([...new Set(kindsShown.map((k) => k.device))]);

	function pickKind(e: Event) {
		const kind = (e.currentTarget as HTMLSelectElement).value || null;
		const k = data.kinds.find((x) => x.kind === kind);
		goto(href({ kind, device: data.device ?? (k?.device || null) }));
	}

	let countDraft = $state('');
	$effect(() => {
		countDraft = data.count === 'all' ? '' : String(data.count);
	});
	function applyCount() {
		const n = Math.floor(Number(countDraft));
		if (Number.isFinite(n) && n >= 1 && n !== data.count) goto(href({ count: n }));
	}

	function when(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime())
			? ''
			: d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function ms(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '' : `.${String(d.getMilliseconds()).padStart(3, '0')}`;
	}

	const secs = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
	const took = (m: { endAt?: string | null; durationMs: number | null }) => (m.endAt && m.durationMs != null ? `${secs(m.durationMs / 1000)} s` : '');
	const robotShort = (name: string | null | undefined) => (name ? name.replace(/^.*?([A-Z]\d{2})$/, '$1') : '');

	const armTiming = $derived(data.timing.filter((t) => t.device === 'arm'));
	const ot2Timing = $derived(data.timing.filter((t) => t.device === 'ot2'));
	const linkTiming = $derived(data.timing.filter((t) => t.device === 'link'));
	const total = (rows: { totalS: number }[]) => rows.reduce((s, t) => s + t.totalS, 0);

	const pill = 'rounded border px-2 py-0.5 text-xs transition-colors';
	const on = `${pill} border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]`;
	const off = `${pill} border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]`;
	const label = 'w-20 shrink-0 font-semibold text-[var(--color-tron-text-secondary)]';
	const badge = 'rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide';
</script>

<div class="mx-auto max-w-6xl space-y-4 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-base font-semibold" style="color: var(--color-tron-cyan)">Movement Log</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/maintenance"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← Maintenance
		</a>
	</div>

	<section class="space-y-2 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-xs">
		<div class="flex flex-wrap items-center gap-2">
			<span class={label}>Device</span>
			{#each devices as d (d.title)}
				<a href={deviceHref(d.device)} class={data.device === d.device ? on : off}>{d.title}</a>
			{/each}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<span class={label}>Type</span>
			<a href={href({ group: null, kind: null })} class={!data.group && !data.kind ? on : off}>All Types</a>
			{#each groupsShown as g, i (g.id)}
				{#if !data.device && (i === 0 || groupsShown[i - 1].device !== g.device)}
					<span class="ml-1" style="color: var(--color-tron-text-secondary)">{DEVICE_TITLES[g.device]}:</span>
				{/if}
				<a href={href({ group: g.id, kind: null, servo: g.device === 'ot2' ? null : data.servo })} class={data.group === g.id && !data.kind ? on : off}>{g.title}</a>
			{/each}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<span class={label}>Exact Type</span>
			<select
				value={data.kind ?? ''}
				onchange={pickKind}
				class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-2 py-0.5 text-xs"
				style="color: var(--color-tron-text)"
			>
				<option value="">All</option>
				{#each kindDevices as dev (dev)}
					<optgroup label={DEVICE_TITLES[dev]}>
						{#each kindsShown.filter((k) => k.device === dev) as k (k.kind)}
							<option value={k.kind}>{kindTitle(k.kind)} ({k.count})</option>
						{/each}
					</optgroup>
				{/each}
			</select>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<span class={label}>Time</span>
			{#each windows as w (w.minutes)}
				<a href={href({ minutes: w.minutes })} class={data.minutes === w.minutes ? on : off}>{w.title}</a>
			{/each}
		</div>
		{#if data.device !== 'ot2'}
			<div class="flex flex-wrap items-center gap-2">
				<span class={label}>Servo</span>
				<a href={href({ servo: null })} class={!data.servo ? on : off}>All Servos</a>
				{#each servos as s (s)}
					<a href={href({ servo: s, device: 'arm' })} class={data.servo === s ? on : off}>Servo {s}</a>
				{/each}
			</div>
		{/if}
		<div class="flex flex-wrap items-center gap-2">
			<span class={label}>Newest</span>
			<input
				type="number"
				min="1"
				step="1"
				bind:value={countDraft}
				onchange={applyCount}
				onkeydown={(e) => e.key === 'Enter' && applyCount()}
				class="w-20 rounded border px-2 py-0.5 font-mono text-xs {data.count === 'all' ? 'border-[var(--color-tron-border)]' : 'border-[var(--color-tron-cyan)]'} bg-[var(--color-tron-bg-secondary)]"
				style="color: var(--color-tron-text)"
				aria-label="Newest Number Of Moves"
			/>
			<a href={href({ count: 'all' })} class={data.count === 'all' ? on : off}>All</a>
			{#if !data.movesError}
				<span class="ml-2" style="color: var(--color-tron-text-secondary)">
					Showing <span class="font-mono" style="color: var(--color-tron-text)">{data.moves.length}</span> Of
					<span class="font-mono" style="color: var(--color-tron-text)">{data.total}</span>
				</span>
			{/if}
		</div>
	</section>

	{#each data.ot2 as r, i (i)}
		{#if r.error}
			<div class="rounded border border-red-500/40 bg-red-900/10 p-2 text-xs text-red-300">Opentron {robotShort(r.robot)} Not Read: {r.error}</div>
		{:else if r.pending && r.logged > 0}
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">More Opentron {robotShort(r.robot)} Commands Load On Refresh</p>
		{/if}
	{/each}

	{#if data.movesError}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{data.movesError}</div>
	{:else}
		{#if data.timing.length}
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<h2 class="mb-2 text-sm font-semibold" style="color: var(--color-tron-cyan)">Timing</h2>
				<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
					{#each [{ title: 'Robot Arm', rows: armTiming }, { title: 'Opentron', rows: ot2Timing }, { title: 'Link', rows: linkTiming }] as g (g.title)}
						<div>
							<div class="mb-1 flex items-baseline justify-between text-xs">
								<span class="font-semibold" style="color: var(--color-tron-text)">{g.title}</span>
								<span class="font-mono" style="color: var(--color-tron-text-secondary)">{secs(total(g.rows))} s</span>
							</div>
							{#if !g.rows.length}
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">Nothing Timed</p>
							{:else}
								<table class="w-full text-left text-xs">
									<thead style="color: var(--color-tron-text-secondary)">
										<tr><th class="py-1 pr-3">Type</th><th class="pr-3">Count</th><th class="pr-3">Total</th><th class="pr-3">Average</th><th class="pr-3">Longest</th></tr>
									</thead>
									<tbody>
										{#each g.rows as t (t.kind)}
											<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
												<td class="py-1 pr-3">{kindTitle(t.kind)}</td>
												<td class="pr-3 font-mono">{t.count}</td>
												<td class="pr-3 font-mono">{secs(t.totalS)} s</td>
												<td class="pr-3 font-mono">{secs(t.avgS)} s</td>
												<td class="pr-3 font-mono">{secs(t.maxS)} s</td>
											</tr>
										{/each}
									</tbody>
								</table>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if data.device !== 'ot2'}
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<table class="w-full text-left text-xs">
					<thead style="color: var(--color-tron-text-secondary)">
						<tr><th class="py-1 pr-3">Servo</th><th class="pr-3">Joint</th><th class="pr-3">Moves</th><th class="pr-3">Direction Changes</th></tr>
					</thead>
					<tbody>
						{#each data.summary as s (s.servo)}
							<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
								<td class="py-1 pr-3">{s.servo}</td>
								<td class="pr-3">{jointTitle(s.servo)}</td>
								<td class="pr-3 font-mono">{s.moves}</td>
								<td class="pr-3 font-mono">{s.reversals}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}

		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<div class="flex items-center justify-between gap-2">
				<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Movement Log</h3>
				<button
					type="button"
					onclick={() => (logHidden = !logHidden)}
					class="rounded border px-2 py-0.5 text-xs"
					style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)"
					aria-expanded={!logHidden}
				>
					{logHidden ? 'Show' : 'Hide'}
				</button>
			</div>
			{#if !logHidden}
				{#if !data.moves.length}
					<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">No Movements Logged</p>
				{:else}
					<table class="mt-2 w-full text-left text-xs">
						<thead style="color: var(--color-tron-text-secondary)">
							<tr>
								<th class="py-1 pr-3">When</th><th class="pr-3">Device</th><th class="pr-3">Type</th><th class="pr-3">Movement</th><th class="pr-3">Took</th><th class="pr-3">Result</th><th class="pr-3">From</th><th class="pr-3">By</th>
							</tr>
						</thead>
						<tbody>
							{#each data.moves as m (m._id)}
								<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
									<td class="whitespace-nowrap py-1 pr-3" style="color: var(--color-tron-text-secondary)">{when(m.at)}<span class="opacity-60">{ms(m.at)}</span></td>
									<td class="whitespace-nowrap pr-3">
										{#if m.device === 'ot2'}
											<span class="{badge} border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]">Opentron</span>
											<span class="ml-1" style="color: var(--color-tron-text-secondary)">{robotShort(m.robot?.name)}</span>
										{:else if m.device === 'link'}
											<span class="{badge} border-[var(--color-tron-border)]" style="color: var(--color-tron-text-secondary)">Link</span>
										{:else}
											<span class="{badge} border-[var(--color-tron-orange)] text-[var(--color-tron-orange)]">Robot Arm</span>
										{/if}
									</td>
									<td class="whitespace-nowrap pr-3">
										{kindTitle(m.kind)}
										{#if groupOfKind(m.device, m.kind)}<span class="ml-1" style="color: var(--color-tron-text-secondary)">{groupOfKind(m.device, m.kind)?.title}</span>{/if}
									</td>
									<td class="pr-3 font-mono">
										{m.line}
										{#if m.frameCount}
											<button
												type="button"
												onclick={() => toggleFrames(m._id)}
												class="ml-2 rounded border px-1.5 py-px font-sans text-[10px]"
												style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)"
												aria-expanded={!!openFrames[m._id]}
											>
												{openFrames[m._id] ? 'Hide Frames' : 'Show Frames'}
											</button>
										{/if}
									</td>
									<td class="whitespace-nowrap pr-3 font-mono">{took(m)}</td>
									<td class="pr-3">
										{#if m.ok}
											<span class="text-green-300">{m.device === 'ot2' ? 'Done' : m.device === 'link' ? 'Answered' : m.kind.startsWith('reading_') ? 'Read' : 'Sent'}</span>
										{:else}
											<span class="text-red-300">Failed</span>
											<span class="ml-1" style="color: var(--color-tron-text-secondary)">{m.error}</span>
										{/if}
									</td>
									<td class="whitespace-nowrap pr-3" style="color: var(--color-tron-text-secondary)">{m.from ?? ''}</td>
									<td class="whitespace-nowrap pr-3">{m.movedBy?.username ?? ''}</td>
								</tr>
								{#if openFrames[m._id]}
									{@const o = openFrames[m._id]}
									<tr>
										<td colspan="8" class="pb-2 pl-6">
											{#if o.loading}
												<p class="text-xs" style="color: var(--color-tron-text-secondary)">Loading Frames</p>
											{:else if o.error || !o.frames}
												<p class="text-xs text-red-300">{o.error ?? 'No Frames Kept'}</p>
											{:else}
												{@const f = o.frames}
												<div class="max-h-96 overflow-auto rounded border border-[var(--color-tron-border)]">
													<table class="w-full text-left font-mono text-[11px]">
														<thead class="sticky top-0 bg-[var(--color-tron-surface)]" style="color: var(--color-tron-text-secondary)">
															<tr>
																<th class="px-2 py-1">Frame</th><th class="pr-3">Time</th>
																{#each servos as s (s)}<th class="pr-3">Servo {s}</th>{/each}
																<th class="pr-3">Fire</th>
															</tr>
														</thead>
														<tbody>
															{#each f.t as t, i (i)}
																<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
																	<td class="px-2">{i + 1}</td>
																	<td class="pr-3">{t.toFixed(3)} s</td>
																	{#each servos as s (s)}<td class="pr-3">{f.goals[i]?.[s - 1] ?? ''}</td>{/each}
																	<td class="pr-3">{fireAt(f, t)}</td>
																</tr>
															{/each}
														</tbody>
													</table>
												</div>
											{/if}
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				{/if}
			{/if}
		</section>
	{/if}
</div>
