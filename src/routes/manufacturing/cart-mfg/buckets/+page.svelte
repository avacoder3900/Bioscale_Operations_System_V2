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
				config: { notificationsEnabled: boolean; rollsOnHandPinned: boolean; rollsOnHandOverride: number; cmPerCartridge: number; rollLengthCm: number; minRollsInInventory: number };
				roll: { id: string; lotId: string | null; lengthCm: number; consumedCm: number; remainingCm: number; remainingCartridges: number; openedAt: string | null; openedBy: string | null } | null;
				rollsOnHand: number; rollsOnHandLive: number; minRolls: number; belowFloor: boolean;
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
			auditScan?: ActionResult; audit?: ActionResult;
		} | null;
	}
	let { data, form }: Props = $props();

	// Thermoseal (BUCKET-SYSTEM_PLAN v2 §3.4): length a barcoded → unpressed move will take.
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
	type CycleMode = 'view' | 'advance' | 'scrap' | 'audit';
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
	let residualDisposition = $state<'merge' | 'scrap' | ''>('');

	// Leftover flow (v2 §7, simplified 2026-09-23): Merge or Discard. Merge goes to a
	// bucket at the stage the carts were last in (this bucket's previous pass);
	// Discard is a bulk QR scan + journal. Carts are tracked by id, so both need
	// the scans; the server validates on submit.
	let residualDest = $state('');
	function stageLabel(stage: string | null | undefined): string { return stage ? (data.stages.find(s => s.key === stage)?.label ?? stage) : '—'; }
	// Destinations for a stage: open passes at that stage first, then empty buckets (this one first — the carts are already in it).
	function residualOptions(stage: string, self: string): { bucketId: string; label: string; newPass: boolean }[] {
		const open = data.board.cycles.filter(c => c.stage === stage).map(c => ({ bucketId: c.bucketId, label: `${shortQr(c.barcode) ?? c.bucketId} · ${c.bucketId} #${c.cycleNumber} · ${c.quantity} cart${c.quantity === 1 ? '' : 's'} at ${stageLabel(stage)}`, newPass: false }));
		const empties = [...data.board.available].sort((a, b) => (a.bucketId === self ? -1 : b.bucketId === self ? 1 : 0))
			.map(b => ({ bucketId: b.bucketId, label: `${shortQr(b.barcode) ?? b.bucketId} · ${b.bucketId} — empty, start a new pass at ${stageLabel(stage)}${b.bucketId === self ? ' (this bucket)' : ''}`, newPass: true }));
		return [...open, ...empties];
	}
	function residualDestFor(stage: string, self: string): string {
		const opts = residualOptions(stage, self);
		return residualDest && opts.some(o => o.bucketId === residualDest) ? residualDest : (opts[0]?.bucketId ?? '');
	}

	// Cart QR search under the board: read-only, one line back (?/cartLookup).
	let cartFind = $state('');
	let cartFindBusy = $state(false);
	let cartFindLine = $state('');
	let cartFindOk = $state(true);
	async function findCart() {
		const code = cartFind.trim();
		if (!code || cartFindBusy) return;
		cartFindBusy = true;
		try {
			const fd = new FormData();
			fd.set('barcode', code);
			const res = await fetch('?/cartLookup', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				const r = (result.data as any)?.cartLookup;
				cartFindOk = !!r?.found;
				cartFindLine = r?.line ?? 'No answer from the server.';
			} else if (result.type === 'failure') { cartFindOk = false; cartFindLine = (result.data as any)?.cartLookup?.error ?? `Error ${result.status}`; }
			else if (result.type === 'error') { cartFindOk = false; cartFindLine = result.error?.message ?? 'Lookup failed'; }
		} catch (e) {
			cartFindOk = false;
			cartFindLine = e instanceof Error ? e.message : 'Lookup failed';
		} finally {
			cartFindBusy = false;
		}
	}

	// Barcoded-stage scan-in (fetch per cart so the box stays hot).
	let cartScan = $state('');
	let cartScanBusy = $state(false);
	let cartScanError = $state('');
	let cartScanOk = $state('');

	const cyclesByStage = $derived.by(() => {
		const m: Record<BucketStage, BoardCycle[]> = { barcoded: [], unpressed: [], pressed: [] };
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

	// Audit (§9.8): scan the tub empty, then say what happens to anything that
	// does not belong. Each scan is classified server-side (?/auditScan) so the
	// operator sees "belongs here" / "wrong tub" as they go.
	type AuditScan = {
		barcode: string;
		finding: 'member' | 'foreign' | 'ineligible' | 'unknown' | 'bucket';
		status: string | null;
		stage: BucketStage | null;
		homeBucketId: string | null;
		homeCycleId: string | null;
		homeLabel: string | null;
		note: string;
	};
	let auditScans = $state<AuditScan[]>([]);
	let auditInput = $state('');
	let auditBusy = $state(false);
	let auditError = $state('');
	let auditAction = $state<Record<string, 'move' | 'discard'>>({});   // barcode → what happens to it
	let auditDest = $state<Record<string, string>>({});                 // barcode → destination bucket
	type MissingAction = 'keep' | 'discard' | 'release';
	let auditMissingAction = $state<Record<string, MissingAction>>({}); // member not found → what happens to it
	const auditForeign = $derived(auditScans.filter(a => a.finding === 'foreign'));
	const auditIneligible = $derived(auditScans.filter(a => a.finding === 'ineligible' || a.finding === 'unknown' || a.finding === 'bucket'));
	const auditPresent = $derived(auditScans.filter(a => a.finding === 'member').map(a => a.barcode));
	const auditMissing = $derived((panelCycle?.cartridgeIds ?? []).filter(id => !auditPresent.includes(id)));
	const auditDiscards = $derived(auditForeign.filter(a => auditAction[a.barcode] === 'discard').map(a => a.barcode));
	const auditMissingActions = $derived(auditMissing
		.filter(id => auditMissingAction[id] && auditMissingAction[id] !== 'keep')
		.map(id => ({ barcode: id, action: auditMissingAction[id] as 'discard' | 'release' })));
	const auditRemovedMissing = $derived(auditMissingActions.length);
	// Only the cart just scanned is shown while scanning; carts that still need a
	// decision (wrong tub / cannot handle) stay listed, newest first.
	const auditLast = $derived(auditScans.length > 0 ? auditScans[auditScans.length - 1] : null);
	const auditPending = $derived([...auditScans].reverse().filter(a => a.finding !== 'member'));
	// Where a foreign cart can go: its own open pass first, then open passes at its
	// stage, then empty buckets (a new pass opens there at the cart's stage).
	function auditOptions(a: AuditScan): { bucketId: string; label: string }[] {
		if (!a.stage) return [];
		const opts: { bucketId: string; label: string }[] = [];
		if (a.homeBucketId) opts.push({ bucketId: a.homeBucketId, label: `back to ${a.homeLabel} — where it is already a member` });
		for (const o of residualOptions(a.stage, '')) {
			if (o.bucketId === a.homeBucketId) continue;
			if (panelCycle && o.bucketId === panelCycle.bucketId) continue;
			opts.push({ bucketId: o.bucketId, label: o.label });
		}
		return opts;
	}
	function auditDestFor(a: AuditScan): string {
		const opts = auditOptions(a);
		const picked = auditDest[a.barcode];
		return picked && opts.some(o => o.bucketId === picked) ? picked : (opts[0]?.bucketId ?? '');
	}
	const auditMoves = $derived(auditForeign
		.filter(a => (auditAction[a.barcode] ?? 'move') === 'move')
		.map(a => ({ barcode: a.barcode, destinationBucketId: auditDestFor(a) })));
	const auditReady = $derived(auditScans.length > 0
		&& auditIneligible.length === 0
		&& auditMoves.every(m => !!m.destinationBucketId));
	function resetAudit() { auditScans = []; auditInput = ''; auditError = ''; auditAction = {}; auditDest = {}; auditMissingAction = {}; }
	function openAudit(c: BoardCycle) {
		panel = { kind: 'cycle', cycleId: c.cycleId, mode: 'audit' };
		resetLists();
		setTimeout(() => document.getElementById('auditScan')?.focus(), 30);
	}
	async function scanForAudit() {
		const code = auditInput.trim();
		if (!code || auditBusy || panel.kind !== 'cycle') return;
		auditInput = ''; auditError = '';
		if (auditScans.some(a => a.barcode === code)) { auditError = `${code} was already scanned.`; return; }
		auditBusy = true;
		try {
			const fd = new FormData();
			fd.set('cycleId', panel.cycleId);
			fd.set('barcode', code);
			const res = await fetch('?/auditScan', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				const r = (result.data as any)?.auditScan?.scan as AuditScan | undefined;
				if (r) auditScans = [...auditScans, r];
			} else if (result.type === 'failure') auditError = (result.data as any)?.auditScan?.error ?? `Error ${result.status}`;
			else if (result.type === 'error') auditError = result.error?.message ?? 'Scan failed';
		} catch (e) {
			auditError = e instanceof Error ? e.message : 'Scan failed';
		} finally {
			auditBusy = false;
			setTimeout(() => document.getElementById('auditScan')?.focus(), 30);
		}
	}

	function shortQr(barcode: string | null): string | null {
		return barcode ? (barcode.length > 12 ? `${barcode.slice(0, 8)}…` : barcode) : null;
	}
	function resetLists() { discardList = []; scrapList = []; residualList = []; listInput = ''; residualDisposition = ''; residualDest = ''; cartScanError = ''; cartScanOk = ''; }

	function openCycle(c: BoardCycle) { panel = { kind: 'cycle', cycleId: c.cycleId, mode: 'view' }; resetLists(); if (c.stage === 'barcoded') focusCartScan(); }
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
		if (form.audit?.success) { resetAudit(); if (panel.kind === 'cycle') setMode('view'); }
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
			case 'create': return { event: 'Pass opened', moved: '→ Barcoded', discarded: false };
			case 'scan_in': return { event: 'Cart scanned in', moved: 'at Barcoded', discarded: false };
			case 'unscan': return { event: 'Mis-scan removed', moved: 'at Barcoded', discarded: false };
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
	const stageTint: Record<string, string> = { available: 'border-[var(--color-tron-border)]', barcoded: 'border-gray-500/40', unpressed: 'border-blue-500/40', pressed: 'border-amber-500/40', in_oven: 'border-[var(--color-tron-purple)]/50' };
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
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Stick a QR on each shell and scan it into a bucket. Whole buckets move Barcoded → Unpressed → Pressed; WI-01 draws them into the oven.</p>
		</div>
		<div class="flex gap-2">
			<a href="/manufacturing/cart-mfg/buckets/new" class={btnGhost}>New bucket</a>
			{#if data.canAdmin}<a href="/manufacturing/cart-mfg/buckets/override" class="rounded border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/20" title="Move a bucket to any phase, bypassing the flow (admin)">Master override</a>{/if}
			<a href="/manufacturing/cart-mfg/state-change" class={btnGhost} title="Move individual carts to any status (bucket stages ask for a destination bucket)">Cart state change</a>
			<a href="/manufacturing/cart-mfg/wi-01" class={btnGhost}>WI-01 →</a>
		</div>
	</div>

	<!-- Stage strip -->
	<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
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
						<!-- Card = open-the-start-panel button + (admin) Retire control. Two buttons
						     side by side rather than nested, so the retire click never starts a pass. -->
						<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)]/60 {(panel.kind === 'start' || panel.kind === 'retire') && panel.bucketId === b.bucketId ? 'ring-1 ring-[var(--color-tron-cyan)]' : ''}">
							<button type="button" onclick={() => openBucket(b)} class="w-full p-2 text-left">
								<div class="flex items-center justify-between">
									<span class="font-mono text-sm text-[var(--color-tron-text)]">{shortQr(b.barcode) ?? b.bucketId}</span>
									{#if b.spotCheckPending}<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]" title="Confirm empty at next start">check</span>{/if}
								</div>
								<div class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">{b.bucketId} · {b.cycleCount} pass{b.cycleCount === 1 ? '' : 'es'}</div>
							</button>
							{#if data.canAdmin}
								<div class="flex justify-end border-t border-[var(--color-tron-border)]/40 px-2 py-1">
									<button type="button" onclick={() => { panel = { kind: 'retire', bucketId: b.bucketId }; resetLists(); }}
										class="text-[10px] uppercase tracking-wider text-red-300/80 hover:text-red-300" title="Retire this bucket (kill the label) — reason required">Retire</button>
								</div>
							{/if}
						</div>
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
						<p class="px-1 py-4 text-center text-[10px] text-[var(--color-tron-text-secondary)]">No empty buckets.</p>
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
							<!-- Card = open-the-panel button + an expandable list of the carts inside
							     (a sibling <details>, not nested in the button). -->
							<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)]/60 {panel.kind === 'cycle' && panel.cycleId === c.cycleId ? 'ring-1 ring-[var(--color-tron-cyan)]' : ''}">
								<button type="button" onclick={() => openCycle(c)} class="w-full p-2 text-left">
									<div class="flex items-baseline justify-between">
										<span class="font-mono text-sm text-[var(--color-tron-text)]">{shortQr(c.barcode) ?? c.bucketId}</span>
										<span class="text-lg font-bold text-[var(--color-tron-cyan)]">{c.quantity}</span>
									</div>
									<div class="mt-1 flex items-center justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
										<span>{c.bucketId} #{c.cycleNumber} · {dwell(c.stageEnteredAt)}</span>
										{#if c.stage !== 'barcoded' && c.quantity !== c.openedQty}<span title="left Barcoded with {c.openedQty}">−{c.openedQty - c.quantity}</span>{/if}
									</div>
								</button>
								<details class="border-t border-[var(--color-tron-border)]/40 px-2 py-1">
									<summary class="cursor-pointer select-none text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">{c.cartridgeIds.length} cart{c.cartridgeIds.length === 1 ? '' : 's'} inside</summary>
									{#if c.cartridgeIds.length === 0}
										<p class="py-1 text-[10px] text-[var(--color-tron-text-secondary)]">none scanned in yet</p>
									{:else}
										<ul class="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
											{#each c.cartridgeIds as id, i (id)}
												<li class="flex items-center justify-between gap-2 text-[10px]">
													<span class="text-[var(--color-tron-text-secondary)]">{i + 1}.</span>
													<a href="/cartridge-admin?search={encodeURIComponent(id)}" class="min-w-0 flex-1 truncate font-mono text-[var(--color-tron-text)] hover:text-[var(--color-tron-cyan)]" title={id}>{id}</a>
												</li>
											{/each}
										</ul>
									{/if}
								</details>
								<div class="flex justify-end border-t border-[var(--color-tron-border)]/40 px-2 py-1">
									<button type="button" onclick={() => openAudit(c)}
										class="text-[10px] uppercase tracking-wider text-[var(--color-tron-cyan)]/80 hover:text-[var(--color-tron-cyan)]"
										title="Scan every cart in this bucket; anything that does not belong is moved or discarded">Audit</button>
								</div>
							</div>
						{/each}
						{#if cyclesByStage[s.key].length === 0}
							<p class="px-1 py-4 text-center text-[10px] text-[var(--color-tron-text-secondary)]">empty</p>
						{/if}
					</div>

					{#if s.key === 'unpressed' && data.thermoseal}
						{@const ts = data.thermoseal}
						{@const pct = ts.roll ? Math.max(0, Math.min(100, Math.round((ts.roll.remainingCm / ts.roll.lengthCm) * 100))) : 0}
						<!-- Thermoseal lives under Unpressed because that is where it is consumed (v2 §3.4).
						     Yellow card first: counts are NOT synced with production WI-01 (§12.4). -->
						<div class="mt-3 rounded border border-[var(--color-tron-yellow)]/60 bg-[var(--color-tron-yellow)]/10 px-2 py-1.5 text-[10px] text-[var(--color-tron-yellow)]" role="note">
							<strong>⚠ Thermoseal inventory is not synced between systems</strong> — the build live on <code>master</code> still withdraws one PT-CT-112 <em>unit</em> per cart out of this same database; this board counts rolls by length (3.75 cm per cart). Rolls on hand is pinned for development.
						</div>
						<div class="mt-2 rounded border {ts.belowFloor ? 'border-red-500/60' : 'border-[var(--color-tron-border)]'} bg-[var(--color-tron-surface)] p-2 text-[10px]">
							<div class="flex items-center justify-between">
								<span class="font-semibold uppercase tracking-wider text-[var(--color-tron-cyan)]">Thermoseal PT-CT-112</span>
								{#if !ts.config.notificationsEnabled}<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-1 py-0.5 text-[9px] text-[var(--color-tron-text-secondary)]" title="Restock notifications are off (development)">alerts off</span>{/if}
							</div>
							{#if ts.roll}
								<div class="mt-1 flex items-baseline justify-between">
									<span class="text-[var(--color-tron-text-secondary)]">Open roll <span class="font-mono">{ts.roll.id.slice(0, 8)}</span></span>
									<span class="font-mono text-[var(--color-tron-text)]">{fmtM(ts.roll.remainingCm)} · ≈{ts.roll.remainingCartridges} carts</span>
								</div>
								<div class="mt-1 h-1.5 w-full overflow-hidden rounded bg-[var(--color-tron-bg-tertiary)]">
									<div class="h-full {pct <= 10 ? 'bg-red-400' : pct <= 25 ? 'bg-[var(--color-tron-yellow)]' : 'bg-[var(--color-tron-cyan)]'}" style="width: {pct}%"></div>
								</div>
							{:else}
								<p class="mt-1 text-[var(--color-tron-text-secondary)]">No roll open — the first move to Unpressed pulls one{#if ts.nextLot} (lot {ts.nextLot.lotId}){/if}.</p>
							{/if}
							<div class="mt-2 grid grid-cols-2 gap-1">
								<div class="rounded border {ts.belowFloor ? 'border-red-500/60 bg-red-900/20' : 'border-[var(--color-tron-border)]'} px-2 py-1 text-center">
									<p class="uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Rolls on hand</p>
									<p class="text-lg font-bold leading-tight {ts.belowFloor ? 'text-red-300' : 'text-[var(--color-tron-text)]'}">{ts.rollsOnHand}</p>
									<p class="text-[var(--color-tron-text-secondary)]">min {ts.minRolls}{#if ts.config.rollsOnHandPinned} · <span title="Development pin — live PT-CT-112 count is {ts.rollsOnHandLive}">pinned</span>{/if}</p>
								</div>
								<div class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-center">
									<p class="uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Next roll from</p>
									<p class="truncate font-mono text-[var(--color-tron-text)]" title={ts.nextLot?.lotId ?? ''}>{ts.nextLot?.lotId ?? '—'}</p>
									<p class="text-[var(--color-tron-text-secondary)]">{ts.nextLot ? `${ts.nextLot.remaining} left in lot` : 'no lot with stock'}</p>
								</div>
							</div>
							{#if ts.belowFloor}
								<p class="mt-1 text-red-300">Below the {ts.minRolls}-roll floor — {#if !ts.config.notificationsEnabled}notifications off (development), nothing sent.{:else}{ts.openRestockTaskId ? 'restock card open on the' : 'a restock card goes to the'} <a href="/kanban" class="underline">kanban board</a> + email.{/if}</p>
							{/if}
							<!-- Development settings (admin): notifications toggle + rolls-on-hand pin -->
							<details class="mt-2">
								<summary class="cursor-pointer text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Development settings</summary>
								<form method="POST" action="?/thermosealToggles" use:enhance={enhanceBusy} class="mt-1.5 space-y-1.5">
									<label class="flex items-center gap-1.5 {data.canAdmin ? '' : 'opacity-60'}">
										<input type="checkbox" name="notificationsEnabled" value="1" checked={ts.config.notificationsEnabled} disabled={!data.canAdmin || busy} class="accent-[var(--color-tron-cyan)]" />
										<span class="text-[var(--color-tron-text)]">Restock notifications</span>
									</label>
									<label class="flex items-center gap-1.5 {data.canAdmin ? '' : 'opacity-60'}">
										<input type="checkbox" name="rollsOnHandPinned" value="1" checked={ts.config.rollsOnHandPinned} disabled={!data.canAdmin || busy} class="accent-[var(--color-tron-cyan)]" />
										<span class="text-[var(--color-tron-text)]">Pin rolls at</span>
										<input type="number" name="rollsOnHandOverride" min="0" step="1" value={ts.config.rollsOnHandOverride} disabled={!data.canAdmin || busy} class="w-14 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-1.5 py-0.5 text-[var(--color-tron-text)]" />
										<span class="text-[var(--color-tron-text-secondary)]">live {ts.rollsOnHandLive}</span>
									</label>
									<p class="text-[var(--color-tron-text-secondary)]">{ts.config.cmPerCartridge} cm per cart · {fmtM(ts.config.rollLengthCm)} per roll</p>
									{#if data.canAdmin}<button type="submit" disabled={busy} class={btnGhost}>{busy ? 'Saving…' : 'Apply'}</button>{:else}<span class="text-[var(--color-tron-text-secondary)]">manufacturing:admin to change</span>{/if}
									{#if form?.thermosealToggles?.error}<span class="text-[var(--color-tron-error)]">{form.thermosealToggles.error}</span>{/if}
									{#if form?.thermosealToggles?.success}<span class="text-[var(--color-tron-cyan)]">Saved.</span>{/if}
								</form>
							</details>
						</div>
					{/if}
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
							<div class="rounded bg-[var(--color-tron-bg-primary)] p-2"><p class="text-[10px] text-[var(--color-tron-text-secondary)]">Left Barcoded with</p><p class="text-xl font-bold text-[var(--color-tron-text)]">{c.stage === 'barcoded' ? '—' : c.openedQty}</p></div>
							<div class="rounded bg-[var(--color-tron-bg-primary)] p-2"><p class="text-[10px] text-[var(--color-tron-text-secondary)]">Here</p><p class="text-xl font-bold text-[var(--color-tron-text)]">{dwell(c.stageEnteredAt)}</p></div>
						</div>
						<div class="mt-2 text-[10px] text-[var(--color-tron-text-secondary)]">
							{#each c.sourceLots as l (l.partNumber + l.lotId)}<span class="mr-2">{l.partNumber === 'PT-CT-104' ? 'shell' : l.partNumber === 'PT-CT-106' ? 'label' : 'thermoseal'} <span class="font-mono text-[var(--color-tron-text)]">{l.lotId}</span></span>{/each}
						</div>

						{#if panel.mode === 'view'}
							{#if c.stage === 'barcoded'}
								<!-- Barcoded = filling. Scan shells in; each scan is a cartridge's birth. -->
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
							{#if form?.audit?.success && (form.audit as any).result?.cycleId === c.cycleId}
								{@const r = (form.audit as any).result}
								<div class="mt-3 rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-2 text-[10px] text-[var(--color-tron-text-secondary)]">
									<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-cyan)]">Last audit</p>
									<p class="mt-0.5 text-[var(--color-tron-text)]">{r.present.length} of {r.expected} found{#if r.moved.length}, {r.moved.length} moved out{/if}{#if r.discarded.length}, {r.discarded.length} discarded{/if}{#if r.missingDiscarded.length}, {r.missingDiscarded.length} written off{/if}{#if r.missingReleased.length}, {r.missingReleased.length} taken off the pass{/if}.</p>
									{#if r.missing.length > r.missingDiscarded.length + r.missingReleased.length}
										{@const left = r.missing.filter((id: string) => !r.missingDiscarded.includes(id) && !r.missingReleased.includes(id))}
										<p class="mt-0.5 text-[var(--color-tron-yellow)]">Still missing and still on the pass: {left.length}</p>
										<ul class="mt-0.5 max-h-20 space-y-0.5 overflow-y-auto">
											{#each left as id (id)}<li class="truncate font-mono" title={id}>{id}</li>{/each}
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

						{:else if panel.mode === 'audit'}
							<!-- Audit (§9.8): scan the tub empty. Members tick off; anything else is
							     moved to where it belongs or discarded. Members never scanned are
							     reported as missing and stay on the pass. -->
							<form method="POST" action="?/audit" use:enhance={enhanceBusy} class="mt-3 space-y-3">
								<input type="hidden" name="cycleId" value={c.cycleId} />
								<input type="hidden" name="scanned" value={auditScans.map(a => a.barcode).join(',')} />
								<input type="hidden" name="discards" value={auditDiscards.join(',')} />
								<input type="hidden" name="moves" value={JSON.stringify(auditMoves)} />
								<input type="hidden" name="missingActions" value={JSON.stringify(auditMissingActions)} />

								<div class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-2">
									<p class="text-xs text-[var(--color-tron-text)]">Scan <strong>every</strong> cart in this bucket.</p>
									<p class="mt-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">{auditPresent.length} of {c.cartridgeIds.length} found · {auditForeign.length} do not belong{#if auditMissing.length > 0} · {auditMissing.length} not scanned yet{/if}</p>
								</div>

								<div>
									<label for="auditScan" class="text-[10px] uppercase tracking-wider text-[var(--color-tron-cyan)]">Scan a cart</label>
									<input id="auditScan" type="text" bind:value={auditInput} autocomplete="off" disabled={auditBusy} placeholder="scan cart QR…"
										onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scanForAudit(); } }} class={scanCls} />
									{#if auditBusy}<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">Checking…</p>{/if}
									{#if auditError}<p class="mt-1 text-xs text-[var(--color-tron-error)]">{auditError}</p>{/if}
								</div>

								<!-- Just the cart that was scanned: the tick-off list is the counter above. -->
								{#if auditLast}
									{@const a = auditLast}
									<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-1.5">
										<div class="flex items-center justify-between gap-2">
											<span class="min-w-0">
												<span class="block text-[9px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Just scanned</span>
												<span class="block truncate font-mono text-xs text-[var(--color-tron-text)]" title={a.barcode}>{a.barcode}</span>
											</span>
											<span class="flex shrink-0 items-center gap-2">
												{#if a.finding === 'member'}<span class="rounded border border-green-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-green-300">belongs here</span>
												{:else if a.finding === 'foreign'}<span class="rounded border border-[var(--color-tron-yellow)]/50 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">wrong tub</span>
												{:else}<span class="rounded border border-red-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-red-300">cannot handle</span>{/if}
												<button type="button" onclick={() => { auditScans = auditScans.slice(0, -1); }} class="text-[10px] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-error)]" title="Undo this scan">undo</button>
											</span>
										</div>
										{#if a.finding !== 'member'}<p class="mt-0.5 text-[10px] {a.finding === 'foreign' ? 'text-[var(--color-tron-text-secondary)]' : 'text-red-300'}">{a.note}</p>{/if}
									</div>
								{/if}

								<!-- Everything that still needs the operator: never more than the strays. -->
								{#if auditPending.length > 0}
									<div>
										<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-yellow)]">{auditPending.length} scan{auditPending.length === 1 ? '' : 's'} need{auditPending.length === 1 ? 's' : ''} a decision</p>
										<ul class="mt-1 max-h-56 space-y-1 overflow-y-auto">
											{#each auditPending as a (a.barcode)}
												<li class="rounded bg-[var(--color-tron-bg-primary)] px-2 py-1 {a.barcode === auditLast?.barcode ? 'ring-1 ring-[var(--color-tron-cyan)]/50' : ''}">
													<div class="flex items-center justify-between gap-2">
														<span class="truncate font-mono text-xs text-[var(--color-tron-text)]" title={a.barcode}>{a.barcode}</span>
														<span class="flex shrink-0 items-center gap-2">
															{#if a.finding === 'foreign'}<span class="rounded border border-[var(--color-tron-yellow)]/50 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">wrong tub</span>
															{:else}<span class="rounded border border-red-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-red-300">cannot handle</span>{/if}
															<button type="button" onclick={() => { auditScans = auditScans.filter(x => x.barcode !== a.barcode); }} class="text-[10px] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-error)]">remove</button>
														</span>
													</div>
													<p class="mt-0.5 text-[10px] {a.finding === 'foreign' ? 'text-[var(--color-tron-text-secondary)]' : 'text-red-300'}">{a.note}</p>
													{#if a.finding === 'foreign'}
														{@const act = auditAction[a.barcode] ?? 'move'}
														<div class="mt-1 flex flex-wrap items-center gap-2">
															<div class="flex gap-1">
																<button type="button" onclick={() => { auditAction = { ...auditAction, [a.barcode]: 'move' }; }}
																	class="rounded border px-2 py-0.5 text-[10px] {act === 'move' ? 'border-[var(--color-tron-cyan)]/60 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">Move</button>
																<button type="button" onclick={() => { auditAction = { ...auditAction, [a.barcode]: 'discard' }; }}
																	class="rounded border px-2 py-0.5 text-[10px] {act === 'discard' ? 'border-red-500/60 text-red-300' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">Discard</button>
															</div>
															{#if act === 'move'}
																{@const opts = auditOptions(a)}
																{#if opts.length > 0}
																	<select value={auditDestFor(a)} onchange={(e) => { auditDest = { ...auditDest, [a.barcode]: (e.currentTarget as HTMLSelectElement).value }; }}
																		class="{inputCls} flex-1 text-[10px]">
																		{#each opts as o (o.bucketId)}<option value={o.bucketId}>{o.label}</option>{/each}
																	</select>
																{:else}
																	<span class="text-[10px] text-[var(--color-tron-yellow)]">Nowhere to put it — mint a bucket or discard it.</span>
																{/if}
															{/if}
														</div>
													{/if}
												</li>
											{/each}
										</ul>
									</div>
								{/if}

								{#if auditMissing.length > 0 && auditScans.length > 0}
									<!-- Missing members: on the pass but not in the tub. Each one can stay
									     (default), be written off, or be taken off the pass as a loose cart. -->
									<div class="rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/5 p-2">
										<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-yellow)]">{auditMissing.length} member{auditMissing.length === 1 ? '' : 's'} missing — on the pass, not in the tub</p>
										<p class="mt-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">Keep scanning if they are still coming. Anything left as <em>keep</em> stays on the pass and is recorded as missing.</p>
										{#if auditMissing.length > 1}
											<div class="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
												<span class="text-[var(--color-tron-text-secondary)]">All:</span>
												<button type="button" onclick={() => { auditMissingAction = Object.fromEntries(auditMissing.map(id => [id, 'keep'])); }} class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">keep</button>
												<button type="button" onclick={() => { auditMissingAction = Object.fromEntries(auditMissing.map(id => [id, 'discard'])); }} class="rounded border border-red-500/40 px-1.5 py-0.5 text-red-300">write off</button>
												<button type="button" onclick={() => { auditMissingAction = Object.fromEntries(auditMissing.map(id => [id, 'release'])); }} class="rounded border border-[var(--color-tron-cyan)]/40 px-1.5 py-0.5 text-[var(--color-tron-cyan)]">take off pass</button>
											</div>
										{/if}
										<ul class="mt-1.5 max-h-48 space-y-1 overflow-y-auto">
											{#each auditMissing as id (id)}
												{@const act = auditMissingAction[id] ?? 'keep'}
												<li class="rounded bg-[var(--color-tron-bg-primary)] px-2 py-1">
													<div class="flex flex-wrap items-center justify-between gap-2">
														<span class="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-tron-text)]" title={id}>{id}</span>
														<span class="flex shrink-0 gap-1">
															<button type="button" onclick={() => { auditMissingAction = { ...auditMissingAction, [id]: 'keep' }; }}
																class="rounded border px-1.5 py-0.5 text-[10px] {act === 'keep' ? 'border-[var(--color-tron-cyan)]/60 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
																title="Leave it on the pass; the audit records it as missing">Keep</button>
															<button type="button" onclick={() => { auditMissingAction = { ...auditMissingAction, [id]: 'discard' }; }}
																class="rounded border px-1.5 py-0.5 text-[10px] {act === 'discard' ? 'border-red-500/60 text-red-300' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
																title="Gone for good: scrapped off the pass, shell + label written off inventory">Write off</button>
															<button type="button" onclick={() => { auditMissingAction = { ...auditMissingAction, [id]: 'release' }; }}
																class="rounded border px-1.5 py-0.5 text-[10px] {act === 'release' ? 'border-[var(--color-tron-yellow)]/60 text-[var(--color-tron-yellow)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}"
																title="It is somewhere else: off this pass, still a live cart another bucket can take in">Take off pass</button>
														</span>
													</div>
												</li>
											{/each}
										</ul>
										{#if auditRemovedMissing > 0}
											<p class="mt-1 text-[10px] text-[var(--color-tron-yellow)]">{auditRemovedMissing} missing cart{auditRemovedMissing === 1 ? '' : 's'} will leave this pass — the count drops to {Math.max(0, c.quantity - auditRemovedMissing)}.</p>
										{/if}
									</div>
								{/if}

								{#if auditDiscards.length > 0 || auditRemovedMissing > 0}
									<label class="block">
										<span class="text-[10px] uppercase tracking-wider text-red-300">Journal — required ({[auditDiscards.length ? `${auditDiscards.length} discarded` : '', auditRemovedMissing ? `${auditRemovedMissing} missing removed` : ''].filter(Boolean).join(', ')})</span>
										<textarea name="journal" rows="2" required placeholder="What happened to them?" class={inputCls}></textarea>
									</label>
								{/if}
								{#if auditIneligible.length > 0}
									<p class="text-xs text-red-300">Remove the scans the board cannot handle before submitting.</p>
								{/if}
								{#if form?.audit?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.audit.error}</p>{/if}
								<button type="submit" disabled={busy || !auditReady} class={btnPrimary}>
									{busy ? 'Saving…' : `Finish audit — ${auditPresent.length}/${c.cartridgeIds.length} found`
										+ (auditMoves.length ? `, ${auditMoves.length} moved` : '')
										+ (auditDiscards.length ? `, ${auditDiscards.length} discarded` : '')
										+ (auditRemovedMissing ? `, ${auditRemovedMissing} missing removed` : '')}
								</button>
								<button type="button" class={btnGhost} onclick={() => { resetAudit(); setMode('view'); }}>Cancel</button>
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
					{@const last = b.lastStage ?? null}
					{@const opts = last ? residualOptions(last, b.bucketId) : []}
					{@const dest = last ? residualDestFor(last, b.bucketId) : ''}
					<div>
						<div class="font-mono text-lg text-[var(--color-tron-text)]">{shortQr(b.barcode) ?? b.bucketId}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">leftover carts found in this bucket</div>
					</div>
					<form method="POST" action="?/residual" use:enhance={enhanceBusy} class="mt-3 space-y-3">
						<input type="hidden" name="bucketId" value={b.bucketId} />
						<input type="hidden" name="barcodes" value={residualList.join(',')} />
						<input type="hidden" name="moves" value={residualDisposition === 'merge' && dest ? JSON.stringify(residualList.map(barcode => ({ barcode, destinationBucketId: dest }))) : ''} />

						<!-- 1. Merge or Discard -->
						<div class="grid grid-cols-2 gap-2">
							<label class="flex cursor-pointer items-center justify-center gap-2 rounded border px-3 py-2 text-sm {residualDisposition === 'merge' ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-text)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">
								<input type="radio" name="disposition" value="merge" bind:group={residualDisposition} class="sr-only" />Merge
							</label>
							<label class="flex cursor-pointer items-center justify-center gap-2 rounded border px-3 py-2 text-sm {residualDisposition === 'scrap' ? 'border-red-500/60 bg-red-900/20 text-red-200' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">
								<input type="radio" name="disposition" value="scrap" bind:group={residualDisposition} class="sr-only" />Discard
							</label>
						</div>

						{#if residualDisposition === 'merge'}
							<!-- 2a. Merge: the carts were last at this bucket's previous stage; pick where they go. -->
							<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-2 text-xs">
								<p class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Last stage in this bucket</p>
								<p class="mt-0.5"><span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-tron-text)] {last ? (stageTint[last] ?? '') : ''}">{stageLabel(last)}</span></p>
							</div>
							{#if !last}
								<p class="text-xs text-[var(--color-tron-yellow)]">This bucket has never held a pass, so there is no stage to merge at — use <a href="/manufacturing/cart-mfg/state-change" class="underline">Cart state change</a> for these carts instead.</p>
							{:else if opts.length > 0}
								<label class="block">
									<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Merge into</span>
									<select value={dest} onchange={(e) => { residualDest = (e.currentTarget as HTMLSelectElement).value; }} class="{inputCls} text-xs">
										{#each opts as o (o.bucketId)}<option value={o.bucketId}>{o.label}</option>{/each}
									</select>
								</label>
								{#if opts[0].newPass}
									<p class="text-[10px] text-[var(--color-tron-yellow)]">No open pass is at {stageLabel(last)} — an empty bucket is suggested: a new pass opens there at {stageLabel(last)} with these carts. Nothing is debited.</p>
								{/if}
							{:else}
								<p class="text-xs text-[var(--color-tron-yellow)]">No open pass at {stageLabel(last)} and no empty bucket — <strong>mint a new bucket</strong> (<a href="/manufacturing/cart-mfg/buckets/new" class="underline">New bucket</a>); it will appear here as soon as it exists.</p>
							{/if}
							<div>
								<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Scan the carts being merged</span>
								{@render scanList('residual', residualList, 'scan a cart…')}
							</div>
						{:else if residualDisposition === 'scrap'}
							<!-- 2b. Discard: bulk QR scan + journal. Shell + label are scrapped from inventory. -->
							<div>
								<span class="text-[10px] uppercase tracking-wider text-red-300">Scan each cart being discarded (bulk OK)</span>
								{@render scanList('residual', residualList, 'scan a cart…')}
							</div>
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider text-red-300">Journal — why? (required)</span>
								<textarea name="journal" rows="2" required class={inputCls}></textarea>
							</label>
						{/if}

						{#if form?.residual?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.residual.error}</p>{/if}
						{#if residualDisposition}
							<button type="submit" disabled={busy || residualList.length === 0 || (residualDisposition === 'merge' && !dest)} class={residualDisposition === 'scrap' ? btnDanger : btnPrimary}>
								{busy ? 'Saving…' : residualDisposition === 'merge' ? (dest ? `Merge ${residualList.length} → ${dest}` : 'No bucket to merge into — mint one') : `Discard ${residualList.length} & journal`}
							</button>
						{/if}
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; resetLists(); }}>Cancel</button>
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

	<!-- Cart QR search (user, 2026-09-23): scan a cart, get one line telling you
	     where it is. Read-only — it moves nothing and opens no panel. -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<label for="cartFind" class="block text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Find a cart</label>
		<div class="mt-1 flex flex-wrap items-center gap-2">
			<input id="cartFind" type="text" bind:value={cartFind} autocomplete="off" disabled={cartFindBusy}
				placeholder="scan a cart QR…"
				onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findCart(); } }}
				class="min-h-[44px] w-full max-w-sm rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 font-mono text-sm text-[var(--color-tron-text)] placeholder:font-sans placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none" />
			<button type="button" onclick={findCart} disabled={cartFindBusy || !cartFind.trim()}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 text-sm font-medium text-[var(--color-tron-cyan)] disabled:opacity-50">{cartFindBusy ? 'Looking…' : 'Find'}</button>
			{#if cartFindLine}
				<p class="text-xs {cartFindOk ? 'text-[var(--color-tron-text)]' : 'text-[var(--color-tron-yellow)]'}">{cartFindLine}</p>
			{/if}
		</div>
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
