<script lang="ts">
	let { data } = $props();

	const wells: number[] = data.wells ?? [];
	const channels: string[] = data.channels ?? [];

	// Colour a delta cell by how far it sits from the fleet median.
	function deltaClass(d: number | null): string {
		if (d === null) return 'bg-gray-50 text-gray-400';
		const a = Math.abs(d);
		if (a < 25) return 'bg-emerald-50 text-emerald-800';
		if (a < 75) return 'bg-amber-50 text-amber-800';
		return 'bg-rose-100 text-rose-900';
	}

	const fmt = (v: number | null, suffix = '') => (v === null ? '—' : `${v}${suffix}`);
	const signed = (v: number | null) => (v === null ? '—' : v > 0 ? `+${v}` : `${v}`);

	const focus = $derived(data.focus);

	/**
	 * In-plane (X,Y) arrow plus a Z bar. Z dominates by ~30x on this hardware,
	 * so X/Y get their own scale — otherwise every arrow collapses to a dot.
	 */
	const XY_SCALE = 0.22;

	function arrow(x: number | null, y: number | null) {
		if (x === null || y === null) return { x2: 40, y2: 40, len: 0 };
		const dx = x * XY_SCALE;
		const dy = -y * XY_SCALE; // SVG y grows downward
		const clamp = (v: number) => Math.max(-34, Math.min(34, v));
		return { x2: 40 + clamp(dx), y2: 40 + clamp(dy), len: Math.hypot(x, y) };
	}
</script>

<svelte:head><title>Magnetometer — SPU comparison</title></svelte:head>

<div class="p-6 space-y-6">
	<header class="flex flex-wrap items-baseline justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold text-gray-900">Magnetometer — SPU vs SPU</h1>
			<p class="text-sm text-gray-600">
				{data.totals.spus} SPUs · {data.totals.runs} validation runs · 5 wells × 3 channels
			</p>
		</div>
		{#if focus}
			<div class="text-right">
				<div class="text-3xl font-semibold tabular-nums text-gray-900">{focus.label}</div>
				<div class="text-xs text-gray-500">{focus.udi || '—'} · {focus.runs} runs</div>
			</div>
		{/if}
	</header>

	{#if !focus}
		<p class="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
			No magnetometer sessions found.
		</p>
	{:else}
		<!-- Focus vs fleet -->
		<section class="grid gap-4 sm:grid-cols-3">
			<div class="rounded-lg border border-gray-200 bg-white p-4">
				<div class="text-xs uppercase tracking-wide text-gray-500">Mean |B|</div>
				<div class="mt-1 text-2xl font-semibold tabular-nums">{fmt(focus.overallMag)}</div>
			</div>
			<div class="rounded-lg border border-gray-200 bg-white p-4">
				<div class="text-xs uppercase tracking-wide text-gray-500">Δ vs fleet median</div>
				<div class="mt-1 text-2xl font-semibold tabular-nums">{signed(focus.overallDelta)}</div>
			</div>
			<div class="rounded-lg border border-gray-200 bg-white p-4">
				<div class="text-xs uppercase tracking-wide text-gray-500">Last run</div>
				<div class="mt-1 text-sm tabular-nums text-gray-700">
					{focus.lastRunAt ? focus.lastRunAt.slice(0, 10) : '—'}
				</div>
			</div>
		</section>

		<!-- Per well / channel -->
		<section class="rounded-lg border border-gray-200 bg-white">
			<h2 class="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
				SPU {focus.label} per well &amp; channel — value, fleet median, difference
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
						<tr>
							<th class="px-3 py-2 text-left">Well</th>
							{#each channels as ch}
								<th class="px-3 py-2 text-left">Ch {ch} |B|</th>
								<th class="px-3 py-2 text-left">Fleet</th>
								<th class="px-3 py-2 text-left">Δ</th>
							{/each}
						</tr>
					</thead>
					<tbody class="divide-y divide-gray-100">
						{#each wells as w}
							<tr>
								<td class="px-3 py-2 font-medium text-gray-900">{w}</td>
								{#each channels as ch}
									{@const c = focus.cells[String(w)]?.[ch]}
									<td class="px-3 py-2 tabular-nums">
										{fmt(c?.mag ?? null)}
										{#if c?.magSd !== null && c?.magSd !== undefined}
											<span class="ml-1 text-xs text-gray-400">±{c.magSd}</span>
										{/if}
									</td>
									<td class="px-3 py-2 tabular-nums text-gray-500">
										{fmt(data.fleet[String(w)]?.[ch] ?? null)}
									</td>
									<td class="px-3 py-2 tabular-nums {deltaClass(c?.delta ?? null)}">
										{signed(c?.delta ?? null)}
										{#if c?.deltaPct !== null && c?.deltaPct !== undefined}
											<span class="ml-1 text-xs opacity-70">{c.deltaPct}%</span>
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<!-- Field representation -->
		<section class="rounded-lg border border-gray-200 bg-white p-4">
			<h2 class="mb-1 text-sm font-semibold text-gray-900">Field direction per well — SPU {focus.label}</h2>
			<p class="mb-4 text-xs text-gray-500">
				Arrow = in-plane (X,Y), scaled ×{XY_SCALE}. Bar = Z, which dominates |B| by roughly 30×.
			</p>
			<div class="flex flex-wrap gap-4">
				{#each wells as w}
					<div class="rounded border border-gray-200 p-3">
						<div class="mb-1 text-xs font-medium text-gray-700">Well {w}</div>
						<div class="flex gap-2">
							{#each channels as ch}
								{@const c = focus.cells[String(w)]?.[ch]}
								{@const a = arrow(c?.x ?? null, c?.y ?? null)}
								<div class="text-center">
									<svg viewBox="0 0 80 80" class="h-20 w-20" role="img"
										aria-label="Well {w} channel {ch} in-plane field direction">
										<circle cx="40" cy="40" r="34" fill="#fafafa" stroke="#e5e7eb" />
										<line x1="6" y1="40" x2="74" y2="40" stroke="#eee" />
										<line x1="40" y1="6" x2="40" y2="74" stroke="#eee" />
										<line x1="40" y1="40" x2={a.x2} y2={a.y2}
											stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" />
										<circle cx={a.x2} cy={a.y2} r="2.5" fill="#2563eb" />
									</svg>
									<div class="text-[10px] text-gray-500">Ch {ch}</div>
									<div class="text-[10px] tabular-nums text-gray-400">
										Z {fmt(c?.z ?? null)}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</section>

		<!-- Fleet ranking -->
		<section class="rounded-lg border border-gray-200 bg-white">
			<h2 class="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
				All SPUs — ranked by deviation from fleet median
			</h2>
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
						<tr>
							<th class="px-3 py-2 text-left">SPU</th>
							<th class="px-3 py-2 text-left">UDI</th>
							<th class="px-3 py-2 text-right">Runs</th>
							<th class="px-3 py-2 text-right">Mean |B|</th>
							<th class="px-3 py-2 text-right">Δ fleet</th>
							<th class="px-3 py-2 text-left">Last run</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-gray-100">
						{#each data.rows as r}
							<tr class={r.spuId === focus.spuId ? 'bg-blue-50 font-medium' : ''}>
								<td class="px-3 py-2">
									<a class="text-blue-700 hover:underline" href="?spu={r.spuId}">{r.label}</a>
								</td>
								<td class="px-3 py-2 text-xs text-gray-500">{r.udi || '—'}</td>
								<td class="px-3 py-2 text-right tabular-nums">{r.runs}</td>
								<td class="px-3 py-2 text-right tabular-nums">{fmt(r.overallMag)}</td>
								<td class="px-3 py-2 text-right tabular-nums {deltaClass(r.overallDelta)}">
									{signed(r.overallDelta)}
								</td>
								<td class="px-3 py-2 text-xs tabular-nums text-gray-500">
									{r.lastRunAt ? r.lastRunAt.slice(0, 10) : '—'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>
