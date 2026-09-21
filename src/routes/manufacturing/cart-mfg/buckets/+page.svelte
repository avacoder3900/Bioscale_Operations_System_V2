<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type { BoardBucket, BoardCycle, BucketStage, StageCounts } from '$lib/server/services/bucket-service';

	type ActionResult = { success?: boolean; error?: string; code?: string | null; [k: string]: unknown };
	interface Props {
		data: {
			stages: { key: BucketStage; label: string }[];
			focusStage: string | null;
			board: { cycles: BoardCycle[]; available: BoardBucket[]; quarantined: BoardBucket[] };
			counts: StageCounts;
			presses: { name: string; equipmentId: string | null }[];
			lots: Record<string, { lotId: string; remaining: number }[]>;
			canAdjust: boolean;
			scan: { kind: 'bucket' | 'search'; bucket?: any; cycle?: any; matches?: { bucketId: string; barcode: string | null; state: string; cycle: any }[] } | null;
			scanQuery: string;
		};
		form: {
			start?: ActionResult; advance?: ActionResult; adjust?: ActionResult;
			scrap?: ActionResult; residual?: ActionResult; retire?: ActionResult;
		} | null;
	}
	let { data, form }: Props = $props();

	// ── rail state ──────────────────────────────────────────────────────────
	// The panel stores only ids + a mode. The live cycle / bucket objects are
	// looked up from `data` with $derived, so a refetch after an action never
	// leaves the rail holding a stale object — and there is no identity
	// comparison between state proxies and data objects to get wrong.
	type CycleMode = 'view' | 'advance' | 'adjust' | 'scrap';
	type Panel =
		| { kind: 'none' }
		| { kind: 'cycle'; cycleId: string; mode: CycleMode }
		| { kind: 'start'; bucketId: string; step: 'spot_check' | 'form' }
		| { kind: 'residual'; bucketId: string }
		| { kind: 'retire'; bucketId: string };
	let panel = $state<Panel>({ kind: 'none' });
	let scanInput = $state('');
	let shortList = $state<{ bucketId: string; state: string; hint: string }[]>([]);
	let busy = $state(false);

	const cyclesByStage = $derived.by(() => {
		const m: Record<BucketStage, BoardCycle[]> = { raw: [], unpressed: [], pressed: [], qr_pending: [] };
		for (const c of data.board.cycles) m[c.stage]?.push(c);
		return m;
	});
	const allIdleBuckets = $derived([...data.board.available, ...data.board.quarantined]);

	// Narrow `panel` into a local before the .find() callbacks — TS drops the
	// discriminant narrowing inside closures otherwise.
	const panelCycle = $derived.by((): BoardCycle | null => {
		const p = panel;
		if (p.kind !== 'cycle') return null;
		const id = p.cycleId;
		return data.board.cycles.find(c => c.cycleId === id) ?? null;
	});
	const panelBucket = $derived.by((): BoardBucket | null => {
		const p = panel;
		if (p.kind !== 'start' && p.kind !== 'residual' && p.kind !== 'retire') return null;
		const id = p.bucketId;
		return allIdleBuckets.find(b => b.bucketId === id) ?? null;
	});

	function shortQr(barcode: string | null): string | null {
		return barcode ? (barcode.length > 12 ? `${barcode.slice(0, 8)}…` : barcode) : null;
	}

	function openCycle(c: BoardCycle) { panel = { kind: 'cycle', cycleId: c.cycleId, mode: 'view' }; }
	function setMode(mode: CycleMode) {
		if (panel.kind === 'cycle') panel = { kind: 'cycle', cycleId: panel.cycleId, mode };
	}
	function openBucket(b: BoardBucket) {
		if (b.state === 'quarantined') panel = { kind: 'residual', bucketId: b.bucketId };
		else panel = { kind: 'start', bucketId: b.bucketId, step: b.spotCheckPending ? 'spot_check' : 'form' };
	}

	// A tub is labelled either with its printed BKT- id or a UUID QR sticker
	// (`barcode`); the scan box accepts both, exact first, then substring.
	function matchesLabel(bucketId: string, barcode: string | null, code: string): boolean {
		return bucketId === code.toUpperCase() || (barcode != null && barcode.toLowerCase() === code.toLowerCase());
	}
	function containsLabel(bucketId: string, barcode: string | null, code: string): boolean {
		return bucketId.includes(code.toUpperCase()) || (barcode != null && barcode.toLowerCase().includes(code.toLowerCase()));
	}

	function resolveLocal(code: string): boolean {
		const raw = code.trim();
		if (!raw) return false;
		const cycle = data.board.cycles.find(c => matchesLabel(c.bucketId, c.barcode, raw));
		if (cycle) { openCycle(cycle); shortList = []; return true; }
		const bucket = allIdleBuckets.find(b => matchesLabel(b.bucketId, b.barcode, raw));
		if (bucket) { openBucket(bucket); shortList = []; return true; }
		const hits = [
			...data.board.cycles.filter(c => containsLabel(c.bucketId, c.barcode, raw)).map(c => ({ bucketId: c.bucketId, state: 'in_use', hint: `${labelFor(c.stage)} · ${c.quantity}` })),
			...allIdleBuckets.filter(b => containsLabel(b.bucketId, b.barcode, raw)).map(b => ({ bucketId: b.bucketId, state: b.state, hint: b.state === 'quarantined' ? (b.residualNote ?? 'quarantined') : `available · ${b.cycleCount} passes` }))
		].slice(0, 8);
		shortList = hits;
		return hits.length > 0;
	}

	function handleScan() {
		const code = scanInput.trim();
		if (!code) return;
		if (resolveLocal(code)) { scanInput = ''; return; }
		// Not on the board: ask the server (retired / historical buckets).
		const url = new URL($page.url);
		url.searchParams.set('q', code);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.toString(), { keepFocus: true, noScroll: true });
		scanInput = '';
	}

	function labelFor(stage: string): string {
		return data.stages.find(s => s.key === stage)?.label ?? stage;
	}
	function nextLabel(stage: BucketStage): string | null {
		const i = data.stages.findIndex(s => s.key === stage);
		return i >= 0 && i < data.stages.length - 1 ? data.stages[i + 1].label : null;
	}
	function nextKey(stage: BucketStage): BucketStage | null {
		const i = data.stages.findIndex(s => s.key === stage);
		return i >= 0 && i < data.stages.length - 1 ? data.stages[i + 1].key : null;
	}
	function dwell(iso: string | null): string {
		if (!iso) return '—';
		const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
		if (min < 60) return `${min}m`;
		const h = Math.floor(min / 60);
		if (h < 24) return `${h}h ${min % 60}m`;
		return `${Math.floor(h / 24)}d ${h % 24}h`;
	}

	// React to each action result exactly once. `form` keeps the last result
	// until the next action, so without this guard a stale `scrap.success`
	// would keep snapping the panel back to view every time the operator
	// tried to open Scrap or Adjust — the "unresponsive buttons" bug.
	let handledForm: unknown = null;
	$effect(() => {
		if (!form || form === handledForm) return;
		handledForm = form;
		if (form.advance?.success || form.scrap?.success || form.adjust?.success) {
			if (panel.kind === 'cycle') setMode('view');
		}
		if (form.start?.success && typeof form.start.cycleId === 'string') {
			panel = { kind: 'cycle', cycleId: form.start.cycleId, mode: 'view' };
		}
		if (form.residual?.success || form.retire?.success) panel = { kind: 'none' };
	});

	// enhance's default update() re-runs load on success and failure alike, so
	// the board refreshes either way; reset:false keeps a failed form's values.
	const enhanceBusy = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
		};
	};

	const inputCls = 'mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none';
	const btnPrimary = 'w-full rounded-lg bg-[var(--color-tron-cyan)] py-2.5 text-sm font-bold text-[var(--color-tron-bg-primary)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30';
	const btnGhost = 'rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)] disabled:cursor-not-allowed disabled:opacity-40';
	const btnDanger = 'w-full rounded-lg border border-red-500/50 bg-red-900/20 py-2.5 text-sm font-semibold text-red-300 hover:bg-red-900/30 disabled:opacity-30';

	const stageTint: Record<string, string> = {
		available: 'border-[var(--color-tron-border)]',
		raw: 'border-gray-500/40',
		unpressed: 'border-blue-500/40',
		pressed: 'border-amber-500/40',
		qr_pending: 'border-[var(--color-tron-cyan)]/50'
	};
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Production Buckets</h1>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Pre-barcode WIP: each card is one tub's current pass. Whole buckets advance; WI-01 draws from QR Pending.</p>
		</div>
		<div class="flex gap-2">
			<a href="/manufacturing/print-bucket-labels" class={btnGhost}>New buckets / labels</a>
			<a href="/manufacturing/cart-mfg/wi-01" class={btnGhost}>WI-01 →</a>
		</div>
	</div>

	<!-- Stage strip -->
	<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Available</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">{data.counts.available}</p>
			<p class="text-[10px] text-[var(--color-tron-text-secondary)]">empty tubs</p>
		</div>
		{#each data.stages as s (s.key)}
			<div class="rounded-lg border bg-[var(--color-tron-surface)] p-3 {stageTint[s.key]}">
				<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">{s.label}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">{data.counts.stages[s.key].cartridges}</p>
				<p class="text-[10px] text-[var(--color-tron-text-secondary)]">{data.counts.stages[s.key].buckets} bucket{data.counts.stages[s.key].buckets === 1 ? '' : 's'}</p>
			</div>
		{/each}
		<div class="rounded-lg border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-surface)] p-3">
			<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Quarantined</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-yellow)]">{data.counts.quarantined}</p>
			<p class="text-[10px] text-[var(--color-tron-text-secondary)]">need disposition</p>
		</div>
	</div>

	<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
		<!-- Board -->
		<div class="grid grid-cols-1 gap-3 md:grid-cols-5">
			<!-- Available column -->
			<div class="rounded-lg border bg-[var(--color-tron-bg-secondary)] p-2 {data.focusStage === 'available' ? 'ring-1 ring-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)]'}">
				<div class="flex items-center justify-between px-1 pb-2">
					<span class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Available</span>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">{data.board.available.length}</span>
				</div>
				<div class="space-y-2">
					{#each data.board.available as b (b.bucketId)}
						<button type="button" onclick={() => openBucket(b)}
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-2 text-left hover:border-[var(--color-tron-cyan)]/60 {panel.kind === 'start' && panel.bucketId === b.bucketId ? 'ring-1 ring-[var(--color-tron-cyan)]' : ''}">
							<div class="flex items-center justify-between">
								<span class="font-mono text-sm text-[var(--color-tron-text)]">{b.bucketId}</span>
								{#if b.spotCheckPending}<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]" title="Confirm empty at next start">check</span>{/if}
							</div>
							<div class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">{b.cycleCount} pass{b.cycleCount === 1 ? '' : 'es'}{b.homeLocation ? ` · ${b.homeLocation}` : ''}{shortQr(b.barcode) ? ` · qr ${shortQr(b.barcode)}` : ''}</div>
						</button>
					{/each}
					{#each data.board.quarantined as b (b.bucketId)}
						<button type="button" onclick={() => openBucket(b)}
							class="w-full rounded border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/5 p-2 text-left hover:border-[var(--color-tron-yellow)] {panel.kind === 'residual' && panel.bucketId === b.bucketId ? 'ring-1 ring-[var(--color-tron-yellow)]' : ''}">
							<div class="flex items-center justify-between">
								<span class="font-mono text-sm text-[var(--color-tron-text)]">{b.bucketId}</span>
								<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">quarantined</span>
							</div>
							<div class="mt-1 truncate text-[10px] text-[var(--color-tron-text-secondary)]" title={b.residualNote ?? ''}>{b.residualNote ?? 'residual pending'}</div>
						</button>
					{/each}
					{#if data.board.available.length === 0 && data.board.quarantined.length === 0}
						<p class="px-1 py-4 text-center text-[10px] text-[var(--color-tron-text-secondary)]">No empty tubs — <a href="/manufacturing/print-bucket-labels" class="text-[var(--color-tron-cyan)] hover:underline">mint labels</a></p>
					{/if}
				</div>
			</div>

			<!-- Stage columns -->
			{#each data.stages as s (s.key)}
				<div class="rounded-lg border bg-[var(--color-tron-bg-secondary)] p-2 {data.focusStage === s.key ? 'ring-1 ring-[var(--color-tron-cyan)]' : ''} {stageTint[s.key]}">
					<div class="flex items-center justify-between px-1 pb-2">
						<span class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">{s.label}</span>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">{cyclesByStage[s.key].length}</span>
					</div>
					<div class="space-y-2">
						{#each cyclesByStage[s.key] as c (c.cycleId)}
							<button type="button" onclick={() => openCycle(c)}
								class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-2 text-left hover:border-[var(--color-tron-cyan)]/60 {panel.kind === 'cycle' && panel.cycleId === c.cycleId ? 'ring-1 ring-[var(--color-tron-cyan)]' : ''}">
								<div class="flex items-baseline justify-between">
									<span class="font-mono text-sm text-[var(--color-tron-text)]">{c.bucketId}</span>
									<span class="text-lg font-bold text-[var(--color-tron-cyan)]">{c.quantity}</span>
								</div>
								<div class="mt-1 flex items-center justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
									<span>{dwell(c.stageEnteredAt)} here{shortQr(c.barcode) ? ` · qr ${shortQr(c.barcode)}` : ''}</span>
									{#if c.quantity !== c.openedQty}<span title="opened with {c.openedQty}">−{c.openedQty - c.quantity}</span>{/if}
								</div>
							</button>
						{/each}
						{#if cyclesByStage[s.key].length === 0}
							<p class="px-1 py-4 text-center text-[10px] text-[var(--color-tron-text-secondary)]">empty</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<!-- Rail: scan + panel -->
		<aside class="space-y-3">
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-3">
				<label for="bucketScan" class="block text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Scan or search bucket</label>
				<input id="bucketScan" type="text" bind:value={scanInput} autocomplete="off" placeholder="BKT-000123 or sticker"
					onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleScan(); } }}
					oninput={() => { if (scanInput.trim().length >= 3) resolveLocal(scanInput); else shortList = []; }}
					class="mt-1 w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-bg-primary)] px-3 py-2.5 font-mono text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				{#if shortList.length > 0}
					<ul class="mt-2 space-y-1">
						{#each shortList as h (h.bucketId)}
							<li>
								<button type="button" onclick={() => { resolveLocal(h.bucketId); scanInput = ''; }} class="flex w-full items-center justify-between rounded bg-[var(--color-tron-bg-primary)] px-2 py-1.5 text-left hover:bg-[var(--color-tron-cyan)]/10">
									<span class="font-mono text-xs text-[var(--color-tron-text)]">{h.bucketId}</span>
									<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{h.hint}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
				{#if data.scan}
					<div class="mt-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-2 text-xs">
						{#if data.scan.kind === 'bucket'}
							<div class="flex items-center justify-between">
								<span class="font-mono text-[var(--color-tron-text)]">{data.scan.bucket._id}</span>
								<span class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">{data.scan.bucket.state} · {data.scan.bucket.cycleCount} passes</span>
							</div>
							<a href="/manufacturing/cart-mfg/buckets/{data.scan.bucket._id}" class="mt-1 block text-[var(--color-tron-cyan)] hover:underline">Open history →</a>
						{:else if (data.scan.matches ?? []).length === 0}
							<p class="text-[var(--color-tron-text-secondary)]">No bucket matches “{data.scanQuery}”.</p>
						{:else}
							<ul class="space-y-1">
								{#each data.scan.matches ?? [] as m (m.bucketId)}
									<li class="flex items-center justify-between">
										<a href="/manufacturing/cart-mfg/buckets/{m.bucketId}" class="font-mono text-[var(--color-tron-cyan)] hover:underline">{m.bucketId}</a>
										<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{m.cycle ? `${labelFor(m.cycle.stage)} · ${m.cycle.quantity}` : m.state}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Panel -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				{#if panel.kind === 'none'}
					<p class="py-6 text-center text-xs text-[var(--color-tron-text-secondary)]">Scan a bucket or pick a card.</p>

				{:else if panel.kind === 'cycle'}
					{#if !panelCycle}
						<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">This pass is no longer on the board (drained, scrapped out, or refreshing).</p>
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Close</button>
					{:else}
						{@const c = panelCycle}
						{@const nxt = nextKey(c.stage)}
						<div class="flex items-start justify-between">
							<div>
								<div class="font-mono text-lg text-[var(--color-tron-text)]">{c.bucketId} <span class="text-sm text-[var(--color-tron-text-secondary)]">#{c.cycleNumber}</span></div>
								<div class="text-xs text-[var(--color-tron-text-secondary)]">{labelFor(c.stage)} · opened {c.openedAt ? new Date(c.openedAt).toLocaleString() : '—'}{c.openedBy ? ` · ${c.openedBy}` : ''}</div>
							</div>
							<a href="/manufacturing/cart-mfg/buckets/{c.bucketId}" class="text-[10px] text-[var(--color-tron-cyan)] hover:underline">history</a>
						</div>
						<div class="mt-3 grid grid-cols-3 gap-2 text-center">
							<div class="rounded bg-[var(--color-tron-bg-primary)] p-2"><p class="text-[10px] text-[var(--color-tron-text-secondary)]">In tub</p><p class="text-xl font-bold text-[var(--color-tron-cyan)]">{c.quantity}</p></div>
							<div class="rounded bg-[var(--color-tron-bg-primary)] p-2"><p class="text-[10px] text-[var(--color-tron-text-secondary)]">Opened</p><p class="text-xl font-bold text-[var(--color-tron-text)]">{c.openedQty}</p></div>
							<div class="rounded bg-[var(--color-tron-bg-primary)] p-2"><p class="text-[10px] text-[var(--color-tron-text-secondary)]">Here</p><p class="text-xl font-bold text-[var(--color-tron-text)]">{dwell(c.stageEnteredAt)}</p></div>
						</div>
						<div class="mt-2 text-[10px] text-[var(--color-tron-text-secondary)]">
							{#each c.sourceLots as l (l.partNumber + l.lotId)}<span class="mr-2">{l.partNumber} <span class="font-mono text-[var(--color-tron-text)]">{l.lotId}</span></span>{/each}
							{#if c.pressEquipmentName}<span>press <span class="text-[var(--color-tron-text)]">{c.pressEquipmentName}</span></span>{/if}
						</div>

						{#if panel.mode === 'view'}
							<div class="mt-3 space-y-2">
								{#if nxt}
									<button type="button" class={btnPrimary} onclick={() => setMode('advance')}>Advance → {nextLabel(c.stage)}</button>
								{:else}
									<a href="/manufacturing/cart-mfg/wi-01" class="block rounded-lg border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 py-2.5 text-center text-sm font-semibold text-[var(--color-tron-cyan)]">Ready for WI-01 — scan this bucket there</a>
								{/if}
								<div class="grid grid-cols-2 gap-2">
									<button type="button" class={btnGhost} onclick={() => setMode('scrap')}>Scrap…</button>
									<button type="button" class={btnGhost} disabled={!data.canAdjust} title={data.canAdjust ? '' : 'Count corrections require the manufacturing:admin permission'} onclick={() => setMode('adjust')}>
										Adjust count…{#if !data.canAdjust}<span class="ml-1 text-[9px] uppercase tracking-wider">admin</span>{/if}
									</button>
								</div>
								{#if !data.canAdjust}
									<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Adjust needs manufacturing:admin. To empty a bucket, use Scrap.</p>
								{/if}
							</div>

						{:else if panel.mode === 'advance'}
							<form method="POST" action="?/advance" use:enhance={enhanceBusy} class="mt-3 space-y-3">
								<input type="hidden" name="cycleId" value={c.cycleId} />
								<p class="text-sm text-[var(--color-tron-text)]">Move the whole bucket ({c.quantity}) to <strong>{nextLabel(c.stage)}</strong>.</p>
								{#if nxt === 'pressed'}
									<label class="block">
										<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Which press</span>
										<input type="text" name="pressName" list="pressList" required placeholder="Press 1" class={inputCls} />
										<datalist id="pressList">{#each data.presses as p (p.name)}<option value={p.name}></option>{/each}</datalist>
									</label>
								{:else if nxt === 'qr_pending'}
									<label class="block">
										<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Barcode label lot (PT-CT-106) — {c.quantity} labels applied</span>
										<select name="barcodeLotId" required class={inputCls}>
											<option value="">{(data.lots['PT-CT-106'] ?? []).length ? '— Select lot —' : 'No label lots available'}</option>
											{#each data.lots['PT-CT-106'] ?? [] as l (l.lotId)}<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>{/each}
										</select>
									</label>
								{/if}
								{#if form?.advance?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.advance.error}</p>{/if}
								<button type="submit" disabled={busy} class={btnPrimary}>{busy ? 'Saving…' : `Confirm → ${nextLabel(c.stage)}`}</button>
								<button type="button" class={btnGhost} onclick={() => setMode('view')}>Cancel</button>
							</form>

						{:else if panel.mode === 'scrap'}
							<form method="POST" action="?/scrap" use:enhance={enhanceBusy} class="mt-3 space-y-3">
								<input type="hidden" name="cycleId" value={c.cycleId} />
								<label class="block">
									<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">How many scrapped (max {c.quantity})</span>
									<input type="number" name="quantity" min="1" max={c.quantity} required class={inputCls} />
								</label>
								<label class="block">
									<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Journal — why (required)</span>
									<textarea name="journal" rows="3" required placeholder="What happened to them?" class={inputCls}></textarea>
								</label>
								{#if form?.scrap?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.scrap.error}</p>{/if}
								<button type="submit" disabled={busy} class={btnDanger}>{busy ? 'Saving…' : 'Scrap & journal'}</button>
								<button type="button" class={btnGhost} onclick={() => setMode('view')}>Cancel</button>
							</form>

						{:else if panel.mode === 'adjust'}
							<form method="POST" action="?/adjust" use:enhance={enhanceBusy} class="mt-3 space-y-3">
								<input type="hidden" name="cycleId" value={c.cycleId} />
								<p class="text-xs text-[var(--color-tron-text-secondary)]">Physical recount disagrees with {c.quantity}. To empty a bucket use Scrap, so the loss gets a journal entry.</p>
								<label class="block">
									<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Actual count</span>
									<input type="number" name="newQuantity" min="1" required class={inputCls} />
								</label>
								<label class="block">
									<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Reason (required)</span>
									<input type="text" name="reason" required class={inputCls} />
								</label>
								{#if form?.adjust?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.adjust.error}</p>{/if}
								<button type="submit" disabled={busy} class={btnPrimary}>{busy ? 'Saving…' : 'Correct count'}</button>
								<button type="button" class={btnGhost} onclick={() => setMode('view')}>Cancel</button>
							</form>
						{/if}
					{/if}

				{:else if !panelBucket}
					<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">This bucket is no longer idle (its cycle started, or the board is refreshing).</p>
					<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Close</button>

				{:else if panel.kind === 'start'}
					{@const b = panelBucket}
					<div class="flex items-start justify-between">
						<div>
							<div class="font-mono text-lg text-[var(--color-tron-text)]">{b.bucketId}</div>
							<div class="text-xs text-[var(--color-tron-text-secondary)]">available · {b.cycleCount} pass{b.cycleCount === 1 ? '' : 'es'}{b.homeLocation ? ` · ${b.homeLocation}` : ''}</div>
							<div class="text-[10px] text-[var(--color-tron-text-secondary)]">
								{#if b.barcode}sticker <span class="font-mono text-[var(--color-tron-text)]">{b.barcode}</span>{:else}no QR sticker — printed label only{/if}
								· <a href="/manufacturing/print-bucket-labels?bucket={encodeURIComponent(b.bucketId)}" class="text-[var(--color-tron-cyan)] hover:underline">{b.barcode ? 'replace' : 'assign'} QR</a>
							</div>
						</div>
						<div class="flex gap-2">
							<a href="/manufacturing/cart-mfg/buckets/{b.bucketId}" class="text-[10px] text-[var(--color-tron-cyan)] hover:underline">history</a>
							<button type="button" class="text-[10px] text-[var(--color-tron-text-secondary)] hover:underline" onclick={() => { panel = { kind: 'residual', bucketId: b.bucketId }; }}>report contents</button>
						</div>
					</div>

					{#if panel.step === 'spot_check'}
						<div class="mt-4 rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/5 p-3">
							<p class="text-sm font-semibold text-[var(--color-tron-text)]">Is the tub empty?</p>
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Its last pass drained to zero. Look inside before filling.</p>
							<div class="mt-3 grid grid-cols-2 gap-2">
								<button type="button" class={btnPrimary} onclick={() => { panel = { kind: 'start', bucketId: b.bucketId, step: 'form' }; }}>Yes, empty</button>
								<button type="button" class="w-full rounded-lg border border-[var(--color-tron-yellow)]/50 py-2.5 text-sm font-semibold text-[var(--color-tron-yellow)]" onclick={() => { panel = { kind: 'residual', bucketId: b.bucketId }; }}>No — there's some left</button>
							</div>
						</div>
					{:else}
						<form method="POST" action="?/start" use:enhance={enhanceBusy} class="mt-3 space-y-3">
							<input type="hidden" name="bucketId" value={b.bucketId} />
							<input type="hidden" name="emptyConfirmed" value={b.spotCheckPending ? '1' : '0'} />
							{#if b.spotCheckPending}<p class="text-[10px] text-[var(--color-tron-text-secondary)]">✓ Confirmed empty — recorded on this pass.</p>{/if}
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Cartridge blank lot (PT-CT-104)</span>
								<select name="sourceLotId" required class={inputCls}>
									<option value="">{(data.lots['PT-CT-104'] ?? []).length ? '— Select lot —' : 'No lots available'}</option>
									{#each data.lots['PT-CT-104'] ?? [] as l (l.lotId)}<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>{/each}
								</select>
							</label>
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Cartridges going in</span>
								<input type="number" name="quantity" min="1" required class={inputCls} />
							</label>
							{#if form?.start?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.start.error}</p>{/if}
							<button type="submit" disabled={busy} class={btnPrimary}>{busy ? 'Starting…' : 'Start cycle at Raw'}</button>
							<div class="flex justify-between">
								<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Cancel</button>
								<button type="button" class={btnGhost} disabled={!data.canAdjust} title={data.canAdjust ? '' : 'Requires manufacturing:admin'} onclick={() => { panel = { kind: 'retire', bucketId: b.bucketId }; }}>Retire…</button>
							</div>
						</form>
					{/if}

				{:else if panel.kind === 'residual'}
					{@const b = panelBucket}
					<div>
						<div class="font-mono text-lg text-[var(--color-tron-text)]">{b.bucketId}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">{b.state === 'quarantined' ? `quarantined · ${b.residualNote ?? ''}` : 'report leftover contents'}</div>
					</div>
					<form method="POST" action="?/residual" use:enhance={enhanceBusy} class="mt-3 space-y-3">
						<input type="hidden" name="bucketId" value={b.bucketId} />
						<div class="grid grid-cols-2 gap-2">
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">How many</span>
								<input type="number" name="quantity" min="1" required class={inputCls} />
							</label>
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">At stage</span>
								<select name="stage" required class={inputCls}>
									{#each data.stages as s (s.key)}<option value={s.key} selected={s.key === (b.lastStage ?? 'raw')}>{s.label}</option>{/each}
								</select>
							</label>
						</div>
						<fieldset class="space-y-2">
							<legend class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Disposition</legend>
							<label class="flex items-start gap-2 rounded border border-[var(--color-tron-border)] p-2 text-xs text-[var(--color-tron-text)]">
								<input type="radio" name="disposition" value="merge" class="mt-0.5" />
								<span><strong>Merge</strong> into another bucket at the same stage<br />
									<input type="text" name="destinationBucketId" placeholder="scan destination BKT-… or sticker" autocomplete="off" class="{inputCls} font-mono" /></span>
							</label>
							<label class="flex items-start gap-2 rounded border border-[var(--color-tron-border)] p-2 text-xs text-[var(--color-tron-text)]">
								<input type="radio" name="disposition" value="scrap" class="mt-0.5" />
								<span><strong>Scrap</strong> — journal required<br />
									<textarea name="journal" rows="2" placeholder="Why were these scrapped? (also used as the note for Defer)" class={inputCls}></textarea></span>
							</label>
							<label class="flex items-start gap-2 rounded border border-[var(--color-tron-border)] p-2 text-xs text-[var(--color-tron-text)]">
								<input type="radio" name="disposition" value="defer" class="mt-0.5" />
								<span><strong>Defer</strong> — quarantine the tub until someone decides</span>
							</label>
						</fieldset>
						{#if form?.residual?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.residual.error}</p>{/if}
						<button type="submit" disabled={busy} class={btnPrimary}>{busy ? 'Saving…' : 'Record disposition'}</button>
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Cancel</button>
					</form>

				{:else if panel.kind === 'retire'}
					{@const b = panelBucket}
					<form method="POST" action="?/retire" use:enhance={enhanceBusy} class="space-y-3">
						<input type="hidden" name="bucketId" value={b.bucketId} />
						<p class="font-mono text-lg text-[var(--color-tron-text)]">{b.bucketId}</p>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Retiring kills this barcode permanently — a reprinted duplicate can't resurrect it.</p>
						<label class="block">
							<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Reason (required)</span>
							<input type="text" name="reason" required class={inputCls} />
						</label>
						{#if form?.retire?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.retire.error}</p>{/if}
						<button type="submit" disabled={busy} class={btnDanger}>Retire bucket</button>
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'start', bucketId: b.bucketId, step: 'form' }; }}>Cancel</button>
					</form>
				{/if}
			</div>
		</aside>
	</div>
</div>
