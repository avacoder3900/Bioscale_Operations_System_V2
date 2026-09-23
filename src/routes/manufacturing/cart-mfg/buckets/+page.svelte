<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import type { BoardBucket, BoardCycle, BucketStage, ChangeLogRow, RegistryRow, StageCounts } from '$lib/server/services/bucket-service';

	type ActionResult = { success?: boolean; error?: string; code?: string | null; [k: string]: unknown };
	interface Props {
		data: {
			stages: { key: BucketStage; label: string }[];
			inOvenLabel: string;
			focusStage: string | null;
			board: { cycles: BoardCycle[]; available: BoardBucket[]; quarantined: BoardBucket[] };
			counts: StageCounts;
			lots: Record<string, { lotId: string; remaining: number }[]>;
			changeLog: ChangeLogRow[];
			registry: RegistryRow[];
			thermoseal: {
				config: { notificationsEnabled: boolean; cmPerCartridge: number; rollLengthCm: number; minRollsInInventory: number };
				roll: { id: string; lotId: string | null; lengthCm: number; consumedCm: number; remainingCm: number; remainingCartridges: number; openedAt: string | null; openedBy: string | null } | null;
				rollsOnHand: number; minRolls: number; belowFloor: boolean;
				nextLot: { lotId: string; remaining: number } | null;
				openRestockTaskId: string | null; rollsExhausted: number;
			} | null;
			canAdmin: boolean;
			scan: { kind: 'bucket' | 'search'; bucket?: any; cycle?: any; matches?: { bucketId: string; barcode: string | null; state: string; cycle: any }[] } | null;
			scanQuery: string;
		};
		form: {
			start?: ActionResult; advance?: ActionResult; scrap?: ActionResult;
			residual?: ActionResult; retire?: ActionResult; thermosealToggles?: ActionResult;
		} | null;
	}
	let { data, form }: Props = $props();

	// Thermoseal (BUCKET-SYSTEM_PLAN v2 §3.4): length a raw → unpressed move will take.
	function thermosealCm(carts: number): number {
		const per = data.thermoseal?.config.cmPerCartridge ?? 3.75;
		return Math.round(carts * per * 100) / 100;
	}
	function fmtM(cm: number): string { return `${(cm / 100).toFixed(2)} m`; }
	const advanceThermoseal = $derived.by(() => {
		const a = form?.advance;
		if (!a?.success || !a.thermoseal || typeof a.thermoseal !== 'object') return null;
		return a.thermoseal as { cm: number; rollsOpened: number; alert: { rollsOnHand: number; minRolls: number; kanbanCreated: boolean; emailSent: boolean } | null };
	});

	// ── rail state ──────────────────────────────────────────────────────────
	// The panel stores only ids + a mode; the live cycle / bucket objects are
	// looked up from `data` with $derived, so a refetch never leaves the rail
	// holding a stale object.
	type CycleMode = 'view' | 'advance' | 'scrap';
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

	// Scan-based lists for advance-discard, scrap and residual: the operator
	// scans cartridges one at a time; the list is what gets submitted.
	let discardList = $state<string[]>([]);
	let scrapList = $state<string[]>([]);
	let residualList = $state<string[]>([]);
	let listInput = $state('');
	let residualDisposition = $state<'merge' | 'scrap' | 'defer' | ''>('');

	// Raw-stage scan-in (fetch per cart so the box stays hot).
	let cartScan = $state('');
	let cartScanBusy = $state(false);
	let cartScanError = $state('');
	let cartScanOk = $state('');

	const cyclesByStage = $derived.by(() => {
		const m: Record<BucketStage, BoardCycle[]> = { raw: [], unpressed: [], pressed: [] };
		for (const c of data.board.cycles) m[c.stage]?.push(c);
		return m;
	});
	const allIdleBuckets = $derived([...data.board.available, ...data.board.quarantined]);

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
	function resetLists() { discardList = []; scrapList = []; residualList = []; listInput = ''; residualDisposition = ''; cartScanError = ''; cartScanOk = ''; }

	function openCycle(c: BoardCycle) { panel = { kind: 'cycle', cycleId: c.cycleId, mode: 'view' }; resetLists(); if (c.stage === 'raw') focusCartScan(); }
	function setMode(mode: CycleMode) {
		if (panel.kind === 'cycle') panel = { kind: 'cycle', cycleId: panel.cycleId, mode };
		resetLists();
	}
	function openResidual(bucketId: string) { resetLists(); panel = { kind: 'residual', bucketId }; }
	function openBucket(b: BoardBucket) {
		resetLists();
		if (b.state === 'quarantined') openResidual(b.bucketId);
		else panel = { kind: 'start', bucketId: b.bucketId, step: b.spotCheckPending ? 'spot_check' : 'form' };
	}

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
		const url = new URL($page.url);
		url.searchParams.set('q', code);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.toString(), { keepFocus: true, noScroll: true });
		scanInput = '';
	}

	function labelFor(stage: string): string { return data.stages.find(s => s.key === stage)?.label ?? (stage === 'backing' ? data.inOvenLabel : stage); }
	function nextKey(stage: BucketStage): BucketStage | null {
		const i = data.stages.findIndex(s => s.key === stage);
		return i >= 0 && i < data.stages.length - 1 ? data.stages[i + 1].key : null;
	}
	function nextLabel(stage: BucketStage): string { const k = nextKey(stage); return k ? labelFor(k) : data.inOvenLabel; }
	function dwell(iso: string | null): string {
		if (!iso) return '—';
		const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
		if (min < 60) return `${min}m`;
		const h = Math.floor(min / 60);
		if (h < 24) return `${h}h ${min % 60}m`;
		return `${Math.floor(h / 24)}d ${h % 24}h`;
	}

	// Add a scanned cartridge to whichever list the current panel is collecting.
	function addToList(target: 'discard' | 'scrap' | 'residual') {
		const code = listInput.trim();
		listInput = '';
		if (!code) return;
		if (target === 'discard') { if (!discardList.includes(code)) discardList = [...discardList, code]; }
		else if (target === 'scrap') { if (!scrapList.includes(code)) scrapList = [...scrapList, code]; }
		else { if (!residualList.includes(code)) residualList = [...residualList, code]; }
	}
	function removeFromList(target: 'discard' | 'scrap' | 'residual', code: string) {
		if (target === 'discard') discardList = discardList.filter(c => c !== code);
		else if (target === 'scrap') scrapList = scrapList.filter(c => c !== code);
		else residualList = residualList.filter(c => c !== code);
	}

	function focusCartScan() { setTimeout(() => document.getElementById('cartScan')?.focus(), 60); }
	async function scanCartIntoBucket() {
		const code = cartScan.trim();
		if (!code || cartScanBusy || panel.kind !== 'cycle') return;
		cartScanBusy = true; cartScanError = ''; cartScanOk = ''; cartScan = '';
		try {
			const fd = new FormData();
			fd.set('cycleId', panel.cycleId);
			fd.set('barcode', code);
			const res = await fetch('?/scanIn', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success') { cartScanOk = `${code} scanned in`; await invalidateAll(); }
			else if (result.type === 'failure') cartScanError = (result.data as any)?.scanIn?.error ?? `Error ${result.status}`;
			else if (result.type === 'error') cartScanError = result.error?.message ?? 'Scan failed';
		} catch (e) {
			cartScanError = e instanceof Error ? e.message : 'Scan failed';
		} finally {
			cartScanBusy = false;
			focusCartScan();
		}
	}
	async function unscanCartFromBucket(code: string) {
		if (panel.kind !== 'cycle') return;
		cartScanError = ''; cartScanOk = '';
		const fd = new FormData();
		fd.set('cycleId', panel.cycleId);
		fd.set('barcode', code);
		const res = await fetch('?/unscan', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		const result = deserialize(await res.text());
		if (result.type === 'success') { cartScanOk = `${code} removed`; await invalidateAll(); }
		else if (result.type === 'failure') cartScanError = (result.data as any)?.unscan?.error ?? `Error ${result.status}`;
	}

	// React to each action result exactly once (form keeps the last result).
	let handledForm: unknown = null;
	$effect(() => {
		if (!form || form === handledForm) return;
		handledForm = form;
		if (form.advance?.success || form.scrap?.success) { if (panel.kind === 'cycle') setMode('view'); }
		if (form.start?.success && typeof form.start.cycleId === 'string') { panel = { kind: 'cycle', cycleId: form.start.cycleId, mode: 'view' }; resetLists(); focusCartScan(); }
		if (form.residual?.success || form.retire?.success) { panel = { kind: 'none' }; resetLists(); }
	});

	const enhanceBusy = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => { await update({ reset: false }); busy = false; };
	};

	// ── change log ──────────────────────────────────────────────────────────
	let logFilter = $state('');
	const filteredLog = $derived.by(() => {
		const q = logFilter.trim().toLowerCase();
		if (!q) return data.changeLog;
		return data.changeLog.filter(r =>
			r.bucketId.toLowerCase().includes(q) || (r.operator ?? '').toLowerCase().includes(q) || r.type.includes(q) ||
			(r.journal ?? '').toLowerCase().includes(q) || (r.reason ?? '').toLowerCase().includes(q) ||
			r.cartridgeIds.some(id => id.toLowerCase().includes(q))
		);
	});
	const discardedInLog = $derived(data.changeLog.filter(r => r.type === 'scrap' && !r.cycleVoided).reduce((s, r) => s + Math.abs(r.qtyDelta), 0));
	function describe(r: ChangeLogRow): { event: string; moved: string; discarded: boolean } {
		const from = r.fromStage ? labelFor(r.fromStage) : null;
		const to = r.toStage ? labelFor(r.toStage) : null;
		switch (r.type) {
			case 'mint': return { event: 'Bucket created', moved: r.reason ?? '', discarded: false };
			case 'relabel': return { event: 'Sticker', moved: r.reason ?? '', discarded: false };
			case 'create': return { event: 'Pass opened', moved: '→ Raw', discarded: false };
			case 'scan_in': return { event: 'Cart scanned in', moved: 'at Raw', discarded: false };
			case 'unscan': return { event: 'Mis-scan removed', moved: 'at Raw', discarded: false };
			case 'advance': return { event: 'Moved', moved: `${from ?? '?'} → ${to ?? '?'}`, discarded: false };
			case 'consume': return { event: `Drawn by WI-01 → ${data.inOvenLabel}`, moved: `${from ?? 'Pressed'} → ${data.inOvenLabel}`, discarded: false };
			case 'scrap': return { event: 'Discarded', moved: `at ${from ?? '?'}`, discarded: true };
			case 'adjust': return { event: 'Count corrected', moved: `at ${from ?? '?'}`, discarded: false };
			case 'merge_in': return { event: 'Residual received', moved: `at ${to ?? '?'}`, discarded: false };
			case 'merge_out': return { event: 'Residual merged out', moved: `to another bucket`, discarded: false };
			case 'release': return { event: 'Emptied', moved: `${from ?? '?'} → available`, discarded: false };
			case 'quarantine': return { event: 'Quarantined', moved: 'residual deferred', discarded: false };
			case 'retire': return { event: 'Retired', moved: 'label killed', discarded: false };
			case 'void': return { event: 'Pass voided', moved: 'inventory returned', discarded: false };
			default: return { event: r.type, moved: '', discarded: false };
		}
	}
	function fmtAt(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
	}

	// ── bucket log ──────────────────────────────────────────────────────────
	let regState = $state<'all' | 'available' | 'in_use' | 'quarantined' | 'retired'>('all');
	let regFilter = $state('');
	const regCounts = $derived.by(() => {
		const c: Record<string, number> = { available: 0, in_use: 0, quarantined: 0, retired: 0 };
		for (const r of data.registry) c[r.state] = (c[r.state] ?? 0) + 1;
		return c;
	});
	const filteredRegistry = $derived.by(() => {
		const q = regFilter.trim().toLowerCase();
		return data.registry.filter(r => (regState === 'all' || r.state === regState) && (!q || r.bucketId.toLowerCase().includes(q) || (r.barcode ?? '').toLowerCase().includes(q)));
	});
	const regStateLabel: Record<string, string> = { available: 'Available', in_use: 'In use', quarantined: 'Quarantined', retired: 'Retired' };
	const regStateTint: Record<string, string> = {
		available: 'text-green-300 border-green-500/40 bg-green-900/20',
		in_use: 'text-[var(--color-tron-cyan)] border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10',
		quarantined: 'text-[var(--color-tron-yellow)] border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10',
		retired: 'text-red-300 border-red-500/40 bg-red-900/20'
	};

	const inputCls = 'mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none';
	const scanCls = 'mt-1 w-full rounded border border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-bg-primary)] px-3 py-2.5 font-mono text-[var(--color-tron-text)] ring-1 ring-[var(--color-tron-cyan)]/30 placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none';
	const btnPrimary = 'w-full rounded-lg bg-[var(--color-tron-cyan)] py-2.5 text-sm font-bold text-[var(--color-tron-bg-primary)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30';
	const btnGhost = 'rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)] disabled:cursor-not-allowed disabled:opacity-40';
	const btnDanger = 'w-full rounded-lg border border-red-500/50 bg-red-900/20 py-2.5 text-sm font-semibold text-red-300 hover:bg-red-900/30 disabled:opacity-30';
	const stageTint: Record<string, string> = { available: 'border-[var(--color-tron-border)]', raw: 'border-gray-500/40', unpressed: 'border-blue-500/40', pressed: 'border-amber-500/40', in_oven: 'border-[var(--color-tron-purple)]/50' };
</script>

{#snippet scanList(target: 'discard' | 'scrap' | 'residual', list: string[], placeholder: string)}
	<div>
		<input type="text" bind:value={listInput} autocomplete="off" {placeholder}
			onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addToList(target); } }} class={scanCls} />
		{#if list.length > 0}
			<ul class="mt-2 max-h-40 space-y-1 overflow-y-auto">
				{#each list as code (code)}
					<li class="flex items-center justify-between rounded bg-[var(--color-tron-bg-primary)] px-2 py-1">
						<span class="font-mono text-xs text-[var(--color-tron-text)]">{code}</span>
						<button type="button" onclick={() => removeFromList(target, code)} class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-error)]">remove</button>
					</li>
				{/each}
			</ul>
		{/if}
		<p class="mt-1 text-right text-[10px] text-[var(--color-tron-text-secondary)]">{list.length} scanned</p>
	</div>
{/snippet}

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Production Buckets</h1>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Stick a QR on each raw shell and scan it into a bucket. Whole buckets move Raw → Unpressed → Pressed; WI-01 draws them into the oven.</p>
		</div>
		<div class="flex gap-2">
			<a href="/manufacturing/cart-mfg/buckets/new" class={btnGhost}>New bucket</a>
			<a href="/manufacturing/cart-mfg/wi-01" class={btnGhost}>WI-01 →</a>
		</div>
	</div>

	<!-- Inventory rule (BUCKET-SYSTEM_PLAN v2 §3.3 / §8) -->
	<div class="rounded-lg border border-[var(--color-tron-yellow)]/60 bg-[var(--color-tron-yellow)]/10 px-4 py-2.5 text-sm font-semibold text-[var(--color-tron-yellow)]" role="note">
		⚠ Inventory is not Debited Until Carts are Scanned in
		<span class="ml-1 font-normal text-[var(--color-tron-yellow)]/80">— each cart scanned into a bucket takes one shell and one label; moving a bucket to Unpressed takes {data.thermoseal?.config.cmPerCartridge ?? 3.75} cm of thermoseal per cart off the open roll (a roll leaves inventory only when the previous one runs out); a discarded cart takes back its shell and label. WI-01 (In Oven) debits nothing.</span>
	</div>

	<!-- Stage strip -->
	<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Available</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">{data.counts.available}</p>
			<p class="text-[10px] text-[var(--color-tron-text-secondary)]">empty buckets</p>
		</div>
		{#each data.stages as s (s.key)}
			<div class="rounded-lg border bg-[var(--color-tron-surface)] p-3 {stageTint[s.key]}">
				<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">{s.label}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">{data.counts.stages[s.key].cartridges}</p>
				<p class="text-[10px] text-[var(--color-tron-text-secondary)]">{data.counts.stages[s.key].buckets} bucket{data.counts.stages[s.key].buckets === 1 ? '' : 's'}</p>
			</div>
		{/each}
		<a href="/cartridge-admin?stage=backing" class="rounded-lg border bg-[var(--color-tron-surface)] p-3 hover:border-[var(--color-tron-purple)] {stageTint.in_oven}" title="Cartridges drawn into the oven by WI-01">
			<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">{data.inOvenLabel}</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-purple)]">{data.counts.inOven}</p>
			<p class="text-[10px] text-[var(--color-tron-text-secondary)]">carts · via WI-01</p>
		</a>
		<div class="rounded-lg border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-surface)] p-3">
			<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Quarantined</p>
			<p class="mt-1 text-2xl font-bold text-[var(--color-tron-yellow)]">{data.counts.quarantined}</p>
			<p class="text-[10px] text-[var(--color-tron-text-secondary)]">need disposition</p>
		</div>
	</div>

	{#if advanceThermoseal}
		<div class="rounded-lg border px-4 py-2.5 text-sm {advanceThermoseal.alert ? 'border-red-500/60 bg-red-900/20 text-red-200' : 'border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-text)]'}" role="status">
			Thermoseal: {advanceThermoseal.cm} cm ({fmtM(advanceThermoseal.cm)}) taken off the roll{#if advanceThermoseal.rollsOpened > 0} — {advanceThermoseal.rollsOpened} new roll{advanceThermoseal.rollsOpened === 1 ? '' : 's'} pulled from inventory{/if}.
			{#if advanceThermoseal.alert}
				<strong class="ml-1">Only {advanceThermoseal.alert.rollsOnHand} roll{advanceThermoseal.alert.rollsOnHand === 1 ? '' : 's'} left in inventory (minimum {advanceThermoseal.alert.minRolls}).</strong>
				{advanceThermoseal.alert.kanbanCreated ? 'A restock card was added to the kanban board' : 'A restock card is already open on the kanban board'}{advanceThermoseal.alert.emailSent ? ' and the low-inventory list was emailed.' : '.'}
			{/if}
		</div>
	{/if}

	<!-- Thermoseal roll (BUCKET-SYSTEM_PLAN v2 §3.4): consumed by length at raw → unpressed -->
	{#if data.thermoseal}
		{@const ts = data.thermoseal}
		{@const pct = ts.roll ? Math.max(0, Math.min(100, Math.round((ts.roll.remainingCm / ts.roll.lengthCm) * 100))) : 0}
		<div class="rounded-lg border {ts.belowFloor ? 'border-red-500/60' : 'border-[var(--color-tron-border)]'} bg-[var(--color-tron-bg-secondary)] p-3">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 class="text-xs font-semibold uppercase tracking-widest text-[var(--color-tron-cyan)]">
					Thermoseal (PT-CT-112)
					{#if !ts.config.notificationsEnabled}<span class="ml-2 rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[9px] normal-case tracking-normal text-[var(--color-tron-text-secondary)]">restock notifications off — development</span>{/if}
				</h2>
				<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{ts.config.cmPerCartridge} cm per cart · {fmtM(ts.config.rollLengthCm)} per roll · consumed at Raw → Unpressed</span>
			</div>
			<!-- Development toggle (admin): the restock card + email. Roll tracking itself always runs. -->
			<form method="POST" action="?/thermosealToggles" use:enhance={enhanceBusy} class="mt-2 flex flex-wrap items-center gap-4 text-xs">
				<label class="flex items-center gap-2 {data.canAdmin ? '' : 'opacity-60'}">
					<input type="checkbox" name="notificationsEnabled" value="1" checked={ts.config.notificationsEnabled} disabled={!data.canAdmin || busy} class="accent-[var(--color-tron-cyan)]" />
					<span class="text-[var(--color-tron-text)]">Restock notifications</span>
					<span class="text-[var(--color-tron-text-secondary)]">— kanban card + email when rolls in inventory &lt; {ts.minRolls}</span>
				</label>
				{#if data.canAdmin}<button type="submit" disabled={busy} class={btnGhost}>{busy ? 'Saving…' : 'Apply'}</button>{:else}<span class="text-[10px] text-[var(--color-tron-text-secondary)]">manufacturing:admin to change</span>{/if}
				{#if form?.thermosealToggles?.error}<span class="text-[var(--color-tron-error)]">{form.thermosealToggles.error}</span>{/if}
				{#if form?.thermosealToggles?.success}<span class="text-[var(--color-tron-cyan)]">Saved.</span>{/if}
			</form>
			<div class="mt-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
				<div>
					{#if ts.roll}
						<div class="flex items-baseline justify-between text-sm">
							<span class="text-[var(--color-tron-text)]">Open roll <span class="font-mono text-xs text-[var(--color-tron-text-secondary)]">{ts.roll.id.slice(0, 8)}</span>{#if ts.roll.lotId} <span class="text-xs text-[var(--color-tron-text-secondary)]">· lot {ts.roll.lotId}</span>{/if}</span>
							<span class="font-mono text-[var(--color-tron-text)]">{fmtM(ts.roll.remainingCm)} <span class="text-xs text-[var(--color-tron-text-secondary)]">left · ≈{ts.roll.remainingCartridges} carts</span></span>
						</div>
						<div class="mt-1 h-2 w-full overflow-hidden rounded bg-[var(--color-tron-bg-tertiary)]">
							<div class="h-full {pct <= 10 ? 'bg-red-400' : pct <= 25 ? 'bg-[var(--color-tron-yellow)]' : 'bg-[var(--color-tron-cyan)]'}" style="width: {pct}%"></div>
						</div>
						<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">{ts.roll.consumedCm} cm used of {ts.roll.lengthCm} cm{#if ts.roll.openedBy} · opened by {ts.roll.openedBy}{/if}{#if ts.roll.openedAt} {new Date(ts.roll.openedAt).toLocaleDateString()}{/if}</p>
					{:else}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">No roll open — the first move to Unpressed pulls one from inventory{#if ts.nextLot} (lot {ts.nextLot.lotId}){/if}.</p>
					{/if}
				</div>
				<div class="rounded border {ts.belowFloor ? 'border-red-500/60 bg-red-900/20' : 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]'} px-3 py-2 text-center">
					<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Rolls in inventory</p>
					<p class="text-2xl font-bold {ts.belowFloor ? 'text-red-300' : 'text-[var(--color-tron-text)]'}">{ts.rollsOnHand}</p>
					<p class="text-[10px] text-[var(--color-tron-text-secondary)]">minimum {ts.minRolls}</p>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-center">
					<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Next roll from</p>
					<p class="font-mono text-sm text-[var(--color-tron-text)]">{ts.nextLot?.lotId ?? '—'}</p>
					<p class="text-[10px] text-[var(--color-tron-text-secondary)]">{ts.nextLot ? `${ts.nextLot.remaining} left in lot` : 'no lot with stock'}</p>
				</div>
			</div>
			{#if ts.belowFloor}
				<p class="mt-2 text-xs text-red-300">
					Below the {ts.minRolls}-roll floor —
					{#if !ts.config.notificationsEnabled}restock notifications are switched off (development), so no card or email is sent.
					{:else}{ts.openRestockTaskId ? 'a restock card is open on the' : 'a restock card will be added to the'} <a href="/kanban" class="underline">kanban board</a> and the low-inventory list emailed. Receive new rolls to clear it.{/if}
				</p>
			{/if}
		</div>
	{/if}

	<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
		<!-- Board -->
		<div class="grid grid-cols-1 gap-3 md:grid-cols-4">
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
								<span class="font-mono text-sm text-[var(--color-tron-text)]">{shortQr(b.barcode) ?? b.bucketId}</span>
								{#if b.spotCheckPending}<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]" title="Confirm empty at next start">check</span>{/if}
							</div>
							<div class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">{b.bucketId} · {b.cycleCount} pass{b.cycleCount === 1 ? '' : 'es'}</div>
						</button>
					{/each}
					{#each data.board.quarantined as b (b.bucketId)}
						<button type="button" onclick={() => openBucket(b)}
							class="w-full rounded border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/5 p-2 text-left hover:border-[var(--color-tron-yellow)] {panel.kind === 'residual' && panel.bucketId === b.bucketId ? 'ring-1 ring-[var(--color-tron-yellow)]' : ''}">
							<div class="flex items-center justify-between">
								<span class="font-mono text-sm text-[var(--color-tron-text)]">{shortQr(b.barcode) ?? b.bucketId}</span>
								<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">quarantined</span>
							</div>
							<div class="mt-1 truncate text-[10px] text-[var(--color-tron-text-secondary)]" title={b.residualNote ?? ''}>{b.residualNote ?? 'residual pending'}</div>
						</button>
					{/each}
					{#if data.board.available.length === 0 && data.board.quarantined.length === 0}
						<p class="px-1 py-4 text-center text-[10px] text-[var(--color-tron-text-secondary)]">No empty buckets — <a href="/manufacturing/cart-mfg/buckets/new" class="text-[var(--color-tron-cyan)] hover:underline">create one</a></p>
					{/if}
				</div>
			</div>

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
									<span class="font-mono text-sm text-[var(--color-tron-text)]">{shortQr(c.barcode) ?? c.bucketId}</span>
									<span class="text-lg font-bold text-[var(--color-tron-cyan)]">{c.quantity}</span>
								</div>
								<div class="mt-1 flex items-center justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
									<span>{c.bucketId} #{c.cycleNumber} · {dwell(c.stageEnteredAt)}</span>
									{#if c.stage !== 'raw' && c.quantity !== c.openedQty}<span title="left Raw with {c.openedQty}">−{c.openedQty - c.quantity}</span>{/if}
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

		<!-- Rail -->
		<aside class="space-y-3">
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-3">
				<label for="bucketScan" class="block text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Scan a bucket's sticker</label>
				<input id="bucketScan" type="text" bind:value={scanInput} autocomplete="off" placeholder="scan bucket QR…"
					onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleScan(); } }}
					oninput={() => { if (scanInput.trim().length >= 3) resolveLocal(scanInput); else shortList = []; }}
					class={scanCls} />
				{#if shortList.length > 0}
					<ul class="mt-2 space-y-1">
						{#each shortList as h (h.bucketId)}
							<li><button type="button" onclick={() => { resolveLocal(h.bucketId); scanInput = ''; }} class="flex w-full items-center justify-between rounded bg-[var(--color-tron-bg-primary)] px-2 py-1.5 text-left hover:bg-[var(--color-tron-cyan)]/10">
								<span class="font-mono text-xs text-[var(--color-tron-text)]">{h.bucketId}</span><span class="text-[10px] text-[var(--color-tron-text-secondary)]">{h.hint}</span></button></li>
						{/each}
					</ul>
				{/if}
				{#if data.scan}
					<div class="mt-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-2 text-xs">
						{#if data.scan.kind === 'bucket'}
							<div class="flex items-center justify-between"><span class="font-mono text-[var(--color-tron-text)]">{data.scan.bucket._id}</span><span class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">{data.scan.bucket.state} · {data.scan.bucket.cycleCount} passes</span></div>
							<a href="/manufacturing/cart-mfg/buckets/{data.scan.bucket._id}" class="mt-1 block text-[var(--color-tron-cyan)] hover:underline">Open history →</a>
						{:else if (data.scan.matches ?? []).length === 0}
							<p class="text-[var(--color-tron-text-secondary)]">No bucket matches “{data.scanQuery}”.</p>
						{:else}
							<ul class="space-y-1">{#each data.scan.matches ?? [] as m (m.bucketId)}<li class="flex items-center justify-between"><a href="/manufacturing/cart-mfg/buckets/{m.bucketId}" class="font-mono text-[var(--color-tron-cyan)] hover:underline">{m.bucketId}</a><span class="text-[10px] text-[var(--color-tron-text-secondary)]">{m.cycle ? `${labelFor(m.cycle.stage)} · ${m.cycle.quantity}` : m.state}</span></li>{/each}</ul>
						{/if}
					</div>
				{/if}
			</div>

			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				{#if panel.kind === 'none'}
					<p class="py-6 text-center text-xs text-[var(--color-tron-text-secondary)]">Scan a bucket or pick a card.</p>

				{:else if panel.kind === 'cycle'}
					{#if !panelCycle}
						<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">This pass is no longer on the board (drawn into the oven, emptied, or refreshing).</p>
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Close</button>
					{:else}
						{@const c = panelCycle}
						{@const nxt = nextKey(c.stage)}
						<div class="flex items-start justify-between">
							<div>
								<div class="font-mono text-lg text-[var(--color-tron-text)]">{shortQr(c.barcode) ?? c.bucketId}</div>
								<div class="text-xs text-[var(--color-tron-text-secondary)]">{c.bucketId} #{c.cycleNumber} · {labelFor(c.stage)} · opened {c.openedAt ? new Date(c.openedAt).toLocaleString() : '—'}{c.openedBy ? ` · ${c.openedBy}` : ''}</div>
							</div>
							<a href="/manufacturing/cart-mfg/buckets/{c.bucketId}" class="text-[10px] text-[var(--color-tron-cyan)] hover:underline">history</a>
						</div>
						<div class="mt-3 grid grid-cols-3 gap-2 text-center">
							<div class="rounded bg-[var(--color-tron-bg-primary)] p-2"><p class="text-[10px] text-[var(--color-tron-text-secondary)]">Carts</p><p class="text-xl font-bold text-[var(--color-tron-cyan)]">{c.quantity}</p></div>
							<div class="rounded bg-[var(--color-tron-bg-primary)] p-2"><p class="text-[10px] text-[var(--color-tron-text-secondary)]">Left Raw with</p><p class="text-xl font-bold text-[var(--color-tron-text)]">{c.stage === 'raw' ? '—' : c.openedQty}</p></div>
							<div class="rounded bg-[var(--color-tron-bg-primary)] p-2"><p class="text-[10px] text-[var(--color-tron-text-secondary)]">Here</p><p class="text-xl font-bold text-[var(--color-tron-text)]">{dwell(c.stageEnteredAt)}</p></div>
						</div>
						<div class="mt-2 text-[10px] text-[var(--color-tron-text-secondary)]">
							{#each c.sourceLots as l (l.partNumber + l.lotId)}<span class="mr-2">{l.partNumber === 'PT-CT-104' ? 'shell' : l.partNumber === 'PT-CT-106' ? 'label' : 'thermoseal'} <span class="font-mono text-[var(--color-tron-text)]">{l.lotId}</span></span>{/each}
						</div>

						{#if panel.mode === 'view'}
							{#if c.stage === 'raw'}
								<!-- Raw = filling. Scan shells in; each scan is a cartridge's birth. -->
								<div class="mt-3">
									<label for="cartScan" class="text-[10px] uppercase tracking-wider text-[var(--color-tron-cyan)]">Scan carts into this bucket</label>
									<input id="cartScan" type="text" bind:value={cartScan} autocomplete="off" disabled={cartScanBusy} placeholder="scan cart QR…"
										onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scanCartIntoBucket(); } }} class={scanCls} />
									{#if cartScanBusy}<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">Recording…</p>{/if}
									{#if cartScanOk}<p class="mt-1 text-[10px] text-green-300">{cartScanOk}</p>{/if}
									{#if cartScanError}<p class="mt-1 text-xs text-[var(--color-tron-error)]">{cartScanError}</p>{/if}
									{#if c.cartridgeIds.length > 0}
										<ul class="mt-2 max-h-40 space-y-1 overflow-y-auto">
											{#each [...c.cartridgeIds].reverse() as id (id)}
												<li class="flex items-center justify-between rounded bg-[var(--color-tron-bg-primary)] px-2 py-1">
													<span class="font-mono text-xs text-[var(--color-tron-text)]">{id}</span>
													<button type="button" onclick={() => unscanCartFromBucket(id)} class="text-[10px] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-error)]">mis-scan</button>
												</li>
											{/each}
										</ul>
									{/if}
								</div>
							{/if}
							<div class="mt-3 space-y-2">
								{#if nxt}
									<button type="button" class={btnPrimary} disabled={c.quantity === 0} onclick={() => setMode('advance')}>Advance → {nextLabel(c.stage)}</button>
								{:else}
									<a href="/manufacturing/cart-mfg/wi-01" class="block rounded-lg border border-[var(--color-tron-purple)]/60 bg-[var(--color-tron-purple)]/10 py-2.5 text-center text-sm font-semibold text-[var(--color-tron-purple)]">Ready for WI-01 → {data.inOvenLabel}</a>
								{/if}
								<button type="button" class="{btnGhost} w-full" disabled={c.quantity === 0} onclick={() => setMode('scrap')}>Discard carts…</button>
							</div>

						{:else if panel.mode === 'advance'}
							<form method="POST" action="?/advance" use:enhance={enhanceBusy} class="mt-3 space-y-3">
								<input type="hidden" name="cycleId" value={c.cycleId} />
								<input type="hidden" name="discardedIds" value={discardList.join(',')} />
								<p class="text-sm text-[var(--color-tron-text)]">
									Move the bucket to <strong>{nextLabel(c.stage)}</strong>
									{#if discardList.length > 0}— <strong class="text-[var(--color-tron-cyan)]">{Math.max(0, c.quantity - discardList.length)}</strong> carts move, <strong class="text-red-300">{discardList.length}</strong> discarded{:else}— all {c.quantity} carts{/if}.
								</p>
								<div>
									<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Any carts discarded? Scan each one</span>
									{@render scanList('discard', discardList, 'scan a discarded cart…')}
								</div>
								{#if discardList.length > 0}
									<label class="block">
										<span class="text-[10px] uppercase tracking-wider text-red-300">Why were they discarded? (required)</span>
										<input type="text" name="discardJournal" required placeholder="e.g. cracked in press" class={inputCls} />
									</label>
									{#if discardList.length >= c.quantity}<p class="text-xs text-red-300">Discarding every cart closes this pass — nothing moves to {nextLabel(c.stage)}.</p>{/if}
								{/if}
								{#if nxt === 'unpressed'}
									{@const movingCarts = Math.max(0, c.quantity - discardList.length)}
									{@const needCm = thermosealCm(movingCarts)}
									{@const leftCm = data.thermoseal?.roll?.remainingCm ?? 0}
									<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">
										Thermoseal: <span class="font-mono text-[var(--color-tron-text)]">{needCm} cm</span> ({movingCarts} × {data.thermoseal?.config.cmPerCartridge ?? 3.75} cm) comes off the open roll
										{#if data.thermoseal?.roll}({fmtM(leftCm)} left){/if}.
										{#if !data.thermoseal?.roll || needCm > leftCm}<span class="text-[var(--color-tron-yellow)]">A new roll will be pulled from inventory.</span>{/if}
									</div>
									{#if !data.thermoseal?.roll || needCm > leftCm}
										<label class="block">
											<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Lot the new roll comes from (optional — oldest lot with stock if left blank)</span>
											<select name="thermosealLotId" class={inputCls}>
												<option value="">{data.thermoseal?.nextLot ? `Default: ${data.thermoseal.nextLot.lotId}` : '— No lot (part count only) —'}</option>
												{#each data.lots['PT-CT-112'] ?? [] as l (l.lotId)}<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>{/each}
											</select>
										</label>
									{/if}
								{/if}
								{#if form?.advance?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.advance.error}</p>{/if}
								<button type="submit" disabled={busy} class={discardList.length >= c.quantity ? btnDanger : btnPrimary}>
									{busy ? 'Saving…' : discardList.length >= c.quantity ? `Discard all ${c.quantity} & close pass` : discardList.length > 0 ? `Discard ${discardList.length} & move ${c.quantity - discardList.length} → ${nextLabel(c.stage)}` : `Confirm → ${nextLabel(c.stage)}`}
								</button>
								<button type="button" class={btnGhost} onclick={() => setMode('view')}>Cancel</button>
							</form>

						{:else if panel.mode === 'scrap'}
							<form method="POST" action="?/scrap" use:enhance={enhanceBusy} class="mt-3 space-y-3">
								<input type="hidden" name="cycleId" value={c.cycleId} />
								<input type="hidden" name="barcodes" value={scrapList.join(',')} />
								<div>
									<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Scan each cart being discarded</span>
									{@render scanList('scrap', scrapList, 'scan a cart…')}
								</div>
								<label class="block">
									<span class="text-[10px] uppercase tracking-wider text-red-300">Journal — why (required)</span>
									<textarea name="journal" rows="3" required placeholder="What happened to them?" class={inputCls}></textarea>
								</label>
								{#if form?.scrap?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.scrap.error}</p>{/if}
								<button type="submit" disabled={busy || scrapList.length === 0} class={btnDanger}>{busy ? 'Saving…' : `Discard ${scrapList.length} & journal`}</button>
								<button type="button" class={btnGhost} onclick={() => setMode('view')}>Cancel</button>
							</form>
						{/if}
					{/if}

				{:else if !panelBucket}
					<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">This bucket is no longer idle (its pass started, or the board is refreshing).</p>
					<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Close</button>

				{:else if panel.kind === 'start'}
					{@const b = panelBucket}
					<div class="flex items-start justify-between">
						<div>
							<div class="font-mono text-lg text-[var(--color-tron-text)]">{shortQr(b.barcode) ?? b.bucketId}</div>
							<div class="text-xs text-[var(--color-tron-text-secondary)]">{b.bucketId} · available · {b.cycleCount} pass{b.cycleCount === 1 ? '' : 'es'}</div>
						</div>
						<div class="flex gap-2">
							<a href="/manufacturing/cart-mfg/buckets/{b.bucketId}" class="text-[10px] text-[var(--color-tron-cyan)] hover:underline">history</a>
							<button type="button" class="text-[10px] text-[var(--color-tron-text-secondary)] hover:underline" onclick={() => openResidual(b.bucketId)}>report contents</button>
						</div>
					</div>
					{#if panel.step === 'spot_check'}
						<div class="mt-4 rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/5 p-3">
							<p class="text-sm font-semibold text-[var(--color-tron-text)]">Is the bucket empty?</p>
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Its last pass drained to zero. Look inside before filling.</p>
							<div class="mt-3 grid grid-cols-2 gap-2">
								<button type="button" class={btnPrimary} onclick={() => { panel = { kind: 'start', bucketId: b.bucketId, step: 'form' }; }}>Yes, empty</button>
								<button type="button" class="w-full rounded-lg border border-[var(--color-tron-yellow)]/50 py-2.5 text-sm font-semibold text-[var(--color-tron-yellow)]" onclick={() => openResidual(b.bucketId)}>No — carts left</button>
							</div>
						</div>
					{:else}
						<form method="POST" action="?/start" use:enhance={enhanceBusy} class="mt-3 space-y-3">
							<input type="hidden" name="bucketId" value={b.bucketId} />
							<input type="hidden" name="emptyConfirmed" value={b.spotCheckPending ? '1' : '0'} />
							{#if b.spotCheckPending}<p class="text-[10px] text-[var(--color-tron-text-secondary)]">✓ Confirmed empty — recorded on this pass.</p>{/if}
							<p class="text-xs text-[var(--color-tron-text-secondary)]">Pick the lots this pass draws from, then scan shells in one at a time.</p>
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Shell lot (PT-CT-104)</span>
								<select name="shellLotId" required class={inputCls}>
									<option value="">{(data.lots['PT-CT-104'] ?? []).length ? '— Select lot —' : 'No shell lots available'}</option>
									{#each data.lots['PT-CT-104'] ?? [] as l (l.lotId)}<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>{/each}
								</select>
							</label>
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">QR label lot (PT-CT-106)</span>
								<select name="labelLotId" required class={inputCls}>
									<option value="">{(data.lots['PT-CT-106'] ?? []).length ? '— Select lot —' : 'No label lots available'}</option>
									{#each data.lots['PT-CT-106'] ?? [] as l (l.lotId)}<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>{/each}
								</select>
							</label>
							{#if form?.start?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.start.error}</p>{/if}
							<button type="submit" disabled={busy} class={btnPrimary}>{busy ? 'Starting…' : 'Start pass — then scan carts in'}</button>
							<div class="flex justify-between">
								<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Cancel</button>
								<button type="button" class={btnGhost} disabled={!data.canAdmin} title={data.canAdmin ? '' : 'Requires manufacturing:admin'} onclick={() => { panel = { kind: 'retire', bucketId: b.bucketId }; }}>Retire…</button>
							</div>
						</form>
					{/if}

				{:else if panel.kind === 'residual'}
					{@const b = panelBucket}
					<div>
						<div class="font-mono text-lg text-[var(--color-tron-text)]">{shortQr(b.barcode) ?? b.bucketId}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">{b.state === 'quarantined' ? `quarantined · ${b.residualNote ?? ''}` : 'report leftover carts'}</div>
					</div>
					<form method="POST" action="?/residual" use:enhance={enhanceBusy} class="mt-3 space-y-3">
						<input type="hidden" name="bucketId" value={b.bucketId} />
						<input type="hidden" name="barcodes" value={residualList.join(',')} />
						<div>
							<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Scan each leftover cart</span>
							{@render scanList('residual', residualList, 'scan a leftover cart…')}
						</div>
						<fieldset class="space-y-2">
							<legend class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Disposition (applies to all scanned)</legend>
							<label class="flex items-start gap-2 rounded border p-2 text-xs text-[var(--color-tron-text)] {residualDisposition === 'merge' ? 'border-[var(--color-tron-cyan)]/60' : 'border-[var(--color-tron-border)]'}">
								<input type="radio" name="disposition" value="merge" bind:group={residualDisposition} class="mt-0.5" />
								<span><strong>Merge</strong> into another open bucket — the carts take that bucket's stage<br />
									{#if residualDisposition === 'merge'}<input type="text" name="destinationBucketId" required placeholder="scan destination bucket…" autocomplete="off" class="{inputCls} font-mono" />{/if}</span>
							</label>
							<label class="flex items-start gap-2 rounded border p-2 text-xs text-[var(--color-tron-text)] {residualDisposition === 'scrap' ? 'border-red-500/50' : 'border-[var(--color-tron-border)]'}">
								<input type="radio" name="disposition" value="scrap" bind:group={residualDisposition} class="mt-0.5" />
								<span><strong>Discard</strong> them — journal required</span>
							</label>
							<label class="flex items-start gap-2 rounded border p-2 text-xs text-[var(--color-tron-text)] {residualDisposition === 'defer' ? 'border-[var(--color-tron-yellow)]/50' : 'border-[var(--color-tron-border)]'}">
								<input type="radio" name="disposition" value="defer" bind:group={residualDisposition} class="mt-0.5" />
								<span><strong>Defer</strong> — quarantine the bucket until someone decides</span>
							</label>
						</fieldset>
						{#if residualDisposition === 'scrap' || residualDisposition === 'defer'}
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider {residualDisposition === 'scrap' ? 'text-red-300' : 'text-[var(--color-tron-text-secondary)]'}">{residualDisposition === 'scrap' ? 'Journal — why? (required)' : 'Note (optional)'}</span>
								<textarea name="journal" rows="2" required={residualDisposition === 'scrap'} class={inputCls}></textarea>
							</label>
						{/if}
						{#if form?.residual?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.residual.error}</p>{/if}
						<button type="submit" disabled={busy || residualList.length === 0 || !residualDisposition} class={residualDisposition === 'scrap' ? btnDanger : btnPrimary}>
							{busy ? 'Saving…' : residualDisposition === 'merge' ? `Merge ${residualList.length}` : residualDisposition === 'scrap' ? `Discard ${residualList.length} & journal` : residualDisposition === 'defer' ? `Quarantine bucket (${residualList.length})` : 'Pick a disposition'}
						</button>
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Cancel</button>
					</form>

				{:else if panel.kind === 'retire'}
					{@const b = panelBucket}
					<form method="POST" action="?/retire" use:enhance={enhanceBusy} class="space-y-3">
						<input type="hidden" name="bucketId" value={b.bucketId} />
						<p class="font-mono text-lg text-[var(--color-tron-text)]">{shortQr(b.barcode) ?? b.bucketId}</p>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Retiring is permanent; the bucket's history stays.</p>
						<label class="block"><span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Reason (required)</span><input type="text" name="reason" required class={inputCls} /></label>
						{#if form?.retire?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.retire.error}</p>{/if}
						<button type="submit" disabled={busy} class={btnDanger}>Retire bucket</button>
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'start', bucketId: b.bucketId, step: 'form' }; }}>Cancel</button>
					</form>
				{/if}
			</div>
		</aside>
	</div>

	<!-- Change log -->
	<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
		<summary class="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3">
			<span class="text-sm font-medium text-[var(--color-tron-text)]">Change log <span class="text-xs text-[var(--color-tron-text-secondary)]">(last {data.changeLog.length} events)</span></span>
			{#if discardedInLog > 0}<span class="rounded border border-red-500/40 bg-red-900/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-red-300">{discardedInLog} cart{discardedInLog === 1 ? '' : 's'} discarded in this window</span>{:else}<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">no discards in this window</span>{/if}
		</summary>
		<div class="border-t border-[var(--color-tron-border)] p-3">
			<input type="text" bind:value={logFilter} placeholder="filter by bucket, cart, operator, event, or note…" class="mb-3 w-full max-w-md rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none" />
			{#if filteredLog.length === 0}
				<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">{data.changeLog.length === 0 ? 'Nothing has happened yet.' : 'No events match the filter.'}</p>
			{:else}
				<div class="overflow-x-auto"><table class="w-full text-xs">
					<thead><tr class="border-b border-[var(--color-tron-border)] text-left text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]"><th class="px-2 py-1">When</th><th class="px-2 py-1">Lot</th><th class="px-2 py-1">Event</th><th class="px-2 py-1">Moved</th><th class="px-2 py-1 text-right">Carts</th><th class="px-2 py-1">By</th><th class="px-2 py-1">Note</th></tr></thead>
					<tbody>
						{#each filteredLog as r (r.id)}
							{@const d0 = describe(r)}
							{@const d = r.cycleVoided && d0.discarded ? { ...d0, event: 'Discarded (voided pass)', discarded: false } : d0}
							<tr class="border-b border-[var(--color-tron-border)]/40 {d.discarded ? 'bg-red-900/10' : ''} {r.cycleVoided ? 'opacity-60' : ''}" title={r.cycleVoided ? 'This pass was voided — its inventory was returned' : ''}>
								<td class="whitespace-nowrap px-2 py-1 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{fmtAt(r.at)}</td>
								<td class="whitespace-nowrap px-2 py-1 font-mono"><a href="/manufacturing/cart-mfg/buckets/{r.bucketId}" class="text-[var(--color-tron-cyan)] hover:underline">{r.bucketId}</a>{#if r.cycleNumber != null}<span class="text-[var(--color-tron-text-secondary)]"> #{r.cycleNumber}</span>{/if}</td>
								<td class="whitespace-nowrap px-2 py-1 font-semibold {d.discarded ? 'text-red-300' : 'text-[var(--color-tron-text)]'}">{d.event}</td>
								<td class="whitespace-nowrap px-2 py-1 text-[var(--color-tron-text-secondary)]">{d.moved}</td>
								<td class="whitespace-nowrap px-2 py-1 text-right tabular-nums {d.discarded ? 'text-red-300' : 'text-[var(--color-tron-text)]'}">
									{#if d.discarded}−{Math.abs(r.qtyDelta)}{:else if r.type === 'consume'}−{Math.abs(r.qtyDelta)} <span class="text-[var(--color-tron-text-secondary)]">({r.qtyAfter} left)</span>{:else if r.qtyDelta !== 0}{r.qtyDelta > 0 ? '+' : ''}{r.qtyDelta}{:else if r.type === 'advance'}{r.qtyAfter}{:else}—{/if}
								</td>
								<td class="whitespace-nowrap px-2 py-1 text-[var(--color-tron-text-secondary)]">{r.operator ?? '—'}</td>
								<td class="px-2 py-1 text-[var(--color-tron-text-secondary)]" title={r.cartridgeIds.join(', ')}>
									{#if r.type === 'consume' && r.relatedId}<a href="/manufacturing/cart-mfg/lots/{r.relatedId}" class="text-[var(--color-tron-cyan)] hover:underline">WI-01 batch</a>{#if r.reason} · {r.reason}{/if}
									{:else}{r.journal ?? r.reason ?? ''}{/if}
									{#if r.cartridgeIds.length > 0 && r.cartridgeIds.length <= 3}<span class="ml-1 font-mono text-[10px]">{r.cartridgeIds.map(i => i.slice(0, 8)).join(', ')}</span>{:else if r.cartridgeIds.length > 3}<span class="ml-1 font-mono text-[10px]">{r.cartridgeIds.length} carts</span>{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table></div>
			{/if}
		</div>
	</details>

	<!-- Bucket log -->
	<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
		<summary class="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3">
			<span class="text-sm font-medium text-[var(--color-tron-text)]">Bucket log <span class="text-xs text-[var(--color-tron-text-secondary)]">({data.registry.length} bucket{data.registry.length === 1 ? '' : 's'})</span></span>
			<span class="flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wider">{#each ['available', 'in_use', 'quarantined', 'retired'] as s (s)}<span class="rounded border px-1.5 py-0.5 {regStateTint[s]}">{regCounts[s]} {regStateLabel[s]}</span>{/each}</span>
		</summary>
		<div class="border-t border-[var(--color-tron-border)] p-3">
			<div class="mb-3 flex flex-wrap gap-2">
				<select bind:value={regState} class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none">
					<option value="all">All statuses ({data.registry.length})</option>
					{#each ['available', 'in_use', 'quarantined', 'retired'] as s (s)}<option value={s}>{regStateLabel[s]} ({regCounts[s]})</option>{/each}
				</select>
				<input type="text" bind:value={regFilter} placeholder="filter by sticker or id…" class="w-full max-w-md flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none" />
			</div>
			{#if filteredRegistry.length === 0}
				<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">{data.registry.length === 0 ? 'No buckets yet.' : 'No buckets match.'}</p>
			{:else}
				<div class="overflow-x-auto"><table class="w-full text-xs">
					<thead><tr class="border-b border-[var(--color-tron-border)] text-left text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]"><th class="px-2 py-1">Sticker</th><th class="px-2 py-1">Id</th><th class="px-2 py-1">Status</th><th class="px-2 py-1">Right now</th><th class="px-2 py-1 text-right">Passes</th><th class="px-2 py-1">Last activity</th><th class="px-2 py-1">Created</th></tr></thead>
					<tbody>
						{#each filteredRegistry as r (r.bucketId)}
							<tr class="border-b border-[var(--color-tron-border)]/40 {r.state === 'retired' ? 'opacity-70' : ''}">
								<td class="whitespace-nowrap px-2 py-1 font-mono text-[var(--color-tron-text)]" title={r.barcode ?? ''}>{shortQr(r.barcode) ?? '—'}</td>
								<td class="whitespace-nowrap px-2 py-1 font-mono"><a href="/manufacturing/cart-mfg/buckets/{r.bucketId}" class="text-[var(--color-tron-cyan)] hover:underline">{r.bucketId}</a></td>
								<td class="whitespace-nowrap px-2 py-1"><span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider {regStateTint[r.state] ?? ''}">{regStateLabel[r.state] ?? r.state}</span></td>
								<td class="px-2 py-1 text-[var(--color-tron-text-secondary)]">
									{#if r.state === 'in_use' && r.current}<span class="text-[var(--color-tron-text)]">{r.current.quantity}</span> carts at {labelFor(r.current.stage)} <span class="font-mono">#{r.current.cycleNumber}</span>
									{:else if r.state === 'quarantined'}<span class="text-[var(--color-tron-yellow)]">{r.residualNote ?? 'residual pending'}</span>
									{:else if r.state === 'retired'}<span class="text-red-300">{r.retiredReason ?? 'retired'}</span>{#if r.retiredAt} · {fmtAt(r.retiredAt)}{/if}
									{:else if r.spotCheckPending}empty — check pending{:else}empty{/if}
								</td>
								<td class="whitespace-nowrap px-2 py-1 text-right tabular-nums text-[var(--color-tron-text)]">{r.cycleCount}</td>
								<td class="whitespace-nowrap px-2 py-1 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{fmtAt(r.lastActivityAt)}</td>
								<td class="whitespace-nowrap px-2 py-1 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{fmtAt(r.createdAt)}{r.createdBy ? ` · ${r.createdBy}` : ''}</td>
							</tr>
						{/each}
					</tbody>
				</table></div>
			{/if}
		</div>
	</details>
</div>
