<script lang="ts">
	import { untrack } from 'svelte';
	import { deserialize, enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import type { BoardBucket, BoardCycle, BucketStage, CartStatusLine, ChangeLogRow, RegistryRow, StageCounts } from '$lib/server/services/bucket-service';

	type ActionResult = { success?: boolean; error?: string; code?: string | null; [k: string]: unknown };
	interface Props {
		data: {
			stages: { key: BucketStage; label: string }[];
			backedLabel: string;
			focusStage: string | null;
			board: { cycles: BoardCycle[]; available: BoardBucket[]; quarantined: BoardBucket[] };
			counts: StageCounts;
			lots: Record<string, { lotId: string; remaining: number }[]>;
			changeLog: ChangeLogRow[];
			registry: RegistryRow[];
			thermoseal: {
				config: { notificationsEnabled: boolean; cmPerCartridge: number; rollLengthCm: number; minRollsInInventory: number };
				partNumber: string;
				roll: { id: string; lotId: string | null; lengthCm: number; consumedCm: number; remainingCm: number; remainingCartridges: number; openedAt: string | null; openedBy: string | null } | null;
				rollsOnHand: number; minRolls: number; belowFloor: boolean;
				nextLot: { lotId: string; remaining: number } | null;
				openRestockTaskId: string | null; rollsExhausted: number;
			} | null;
			inOven: { count: number; ids: string[] };
			canAdmin: boolean;
			badgeMode: 'off' | 'required';
			canBadgeAdmin: boolean;
			scan: { kind: 'bucket' | 'search' | 'badge'; bucket?: any; cycle?: any; badge?: { displayName: string | null; username: string | null; note: string | null }; matches?: { bucketId: string; barcode: string | null; nickname: string | null; state: string; cycle: any }[] } | null;
			scanQuery: string;
		};
		form: {
			start?: ActionResult; advance?: ActionResult; scrap?: ActionResult;
			residual?: ActionResult; retire?: ActionResult; thermosealToggles?: ActionResult; moveToOven?: ActionResult;
			auditScan?: ActionResult; audit?: ActionResult; pull?: ActionResult;
		} | null;
	}
	let { data, form }: Props = $props();

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

	// ── operator badge (user, 2026-09-30) ────────────────────────────────────
	// One badge PER PASS. It is asked for at the gated steps —
	// starting a pass (2026-10-05), scanning carts into a bucket and taking a
	// mis-scan back out (2026-10-05), EVERY advance (2026-10-02: "require a scan
	// in at every phase"), discarding carts (advance discards, Discard carts…,
	// audit discards / write-offs, leftover discards), Move to oven and retiring
	// a bucket (2026-10-05, admin badge). Scanned once into any badge box (or into a cart box: a
	// BDG- code is routed here), it rides on every scan-in POST and on each gated
	// form FOR THAT PASS until the server rejects it or the operator changes it.
	// Pointing the rail at another pass or bucket, or closing the panel, drops it,
	// so every pass takes a fresh badge scan and the scan-in window never holds a
	// badge left over from an earlier one (user, 2026-10-05: "Do not save badge
	// info in the scan in window between scans. Each pass should require a fresh
	// scan"). The one hand-over: the badge that started a pass stays on for that
	// same pass's cart scans. Until this change one badge carried across the rail.
	const BADGE_RE = /^BDG-[A-Z0-9]{10}$/i;
	let badge = $state('');
	let scanOperator = $state('');   // who the last scan-in was recorded to (from the server)
	let badgeFor = $state<string | null>(null); // what the rail was pointed at when the badge was scanned
	const badgeRequired = $derived(data.badgeMode === 'required');
	// What the rail is pointed at: a pass id, a bucket id (start / leftover / retire), or nothing.
	const panelKey = $derived(panel.kind === 'cycle' ? panel.cycleId : panel.kind === 'none' ? null : panel.bucketId);
	/** Drop the badge if it was scanned for something other than `key`. */
	function retargetBadge(key: string | null) {
		if (badge && key !== badgeFor) { badge = ''; scanOperator = ''; badgeFor = null; }
	}
	// Backstop for every `panel = …` on the board. openCycle also calls it
	// synchronously, so the focus decision that follows sees the cleared badge
	// (effects run after).
	$effect(() => {
		const key = panelKey;
		untrack(() => retargetBadge(key));
	});
	function takeBadge(code: string): boolean {
		if (!BADGE_RE.test(code)) return false;
		badgeFor = panelKey; badge = code; scanOperator = '';
		return true;
	}
	function clearBadge() { badge = ''; scanOperator = ''; focusBadge(); }
	function focusBadge() { setTimeout(() => document.getElementById('badgeScan')?.focus(), 60); }

	// Leftover flow (v2 §7, simplified 2026-09-23): Merge or Discard. Merge goes to a
	// bucket at the stage the carts were last in (this bucket's previous pass);
	// Discard is a bulk QR scan + journal. Carts are tracked by id, so both need
	// the scans; the server validates on submit.
	let residualDest = $state('');
	function stageLabel(stage: string | null | undefined): string { return stage ? (data.stages.find(s => s.key === stage)?.label ?? stage) : '—'; }
	// Destinations for a stage: open passes at that stage first, then empty buckets (this one first — the carts are already in it).
	function residualOptions(stage: string, self: string): { bucketId: string; label: string; newPass: boolean }[] {
		const open = boardCycles.filter(c => c.stage === stage).map(c => ({ bucketId: c.bucketId, label: `${nameOf(c)} · ${c.bucketId} #${c.cycleNumber} · ${c.quantity} cart${c.quantity === 1 ? '' : 's'} at ${stageLabel(stage)}`, newPass: false }));
		const empties = [...data.board.available].sort((a, b) => (a.bucketId === self ? -1 : b.bucketId === self ? 1 : 0))
			.map(b => ({ bucketId: b.bucketId, label: `${nameOf(b)} · ${b.bucketId} — empty, start a new pass at ${stageLabel(stage)}${b.bucketId === self ? ' (this bucket)' : ''}`, newPass: true }));
		return [...open, ...empties];
	}
	function residualDestFor(stage: string, self: string): string {
		const opts = residualOptions(stage, self);
		return residualDest && opts.some(o => o.bucketId === residualDest) ? residualDest : (opts[0]?.bucketId ?? '');
	}

	// Cart QR search under the board: read-only, one answer back (?/cartLookup).
	// Since 2026-10-02 the answer is structured (cart status, the bucket it is in
	// with its nickname + state) and rendered as colour-coded pills, the way the
	// bucket search list and the bucket log mark status; `line` is the plain-text
	// fallback for "not found" and errors.
	type CartHit = CartStatusLine & { found: true; cartridgeId: string };
	type CartLookup = { ok: boolean; line: string; hit: CartHit | null };
	let cartFind = $state('');
	let cartFindBusy = $state(false);
	let cartFindLine = $state('');
	let cartFindOk = $state(true);
	let cartFindHit = $state<CartHit | null>(null);
	// One read-only lookup, shared by the board box and the leftover panel's
	// "where does it belong?" search.
	async function lookupCart(code: string): Promise<CartLookup> {
		try {
			const fd = new FormData();
			fd.set('barcode', code);
			const res = await fetch('?/cartLookup', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				const r = (result.data as any)?.cartLookup;
				const ok = !!r?.found;
				return { ok, line: r?.line ?? 'No answer from the server.', hit: ok && r?.cartridgeId ? (r as CartHit) : null };
			}
			if (result.type === 'failure') return { ok: false, line: (result.data as any)?.cartLookup?.error ?? `Error ${result.status}`, hit: null };
			if (result.type === 'error') return { ok: false, line: result.error?.message ?? 'Lookup failed', hit: null };
			return { ok: false, line: 'Lookup failed', hit: null };
		} catch (e) {
			return { ok: false, line: e instanceof Error ? e.message : 'Lookup failed', hit: null };
		}
	}
	async function findCart() {
		const code = cartFind.trim();
		if (!code || cartFindBusy) return;
		cartFindBusy = true;
		try {
			const r = await lookupCart(code);
			cartFindOk = r.ok;
			cartFindLine = r.line;
			cartFindHit = r.hit;
		} finally {
			cartFindBusy = false;
		}
	}
	// Pill colours for a cart's own status: the bucket stages follow the column
	// tints (grey / blue / purple); anything downstream of the bucket (wax filled,
	// assembled, …) is neutral. Mirrors regStateTint for buckets.
	const cartStatusTint: Record<string, string> = {
		barcoded: 'text-gray-300 border-gray-500/40 bg-gray-700/20',
		unpressed: 'text-blue-300 border-blue-500/40 bg-blue-900/20',
		pressed: 'text-blue-300 border-blue-500/40 bg-blue-900/20',
		backing: 'text-[var(--color-tron-purple)] border-[var(--color-tron-purple)]/40 bg-[var(--color-tron-purple)]/10'
	};
	const cartStatusTintDefault = 'text-[var(--color-tron-text)] border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]';
	// The "where" pill: green when the cart is a member of an open pass, yellow
	// when it has fallen off one, grey when its last pass is closed.
	const relationTint: Record<string, string> = {
		member: 'text-green-300 border-green-500/40 bg-green-900/20',
		taken_off: 'text-[var(--color-tron-yellow)] border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10',
		closed: 'text-[var(--color-tron-text-secondary)] border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]'
	};
	const relationLabel: Record<string, string> = { member: 'Belongs in', taken_off: 'Taken off', closed: 'Last seen in' };

	// Leftover panel search (user, 2026-09-25): a cart found in an empty tub —
	// where does it belong? Same lookup, its own box so it sits next to the
	// Merge / Discard choice it informs. Read-only; adds nothing to the list.
	let whereFind = $state('');
	let whereBusy = $state(false);
	let whereLine = $state('');
	let whereOk = $state(true);
	let whereHit = $state<CartHit | null>(null);
	async function findWhere() {
		const code = whereFind.trim();
		if (!code || whereBusy) return;
		whereBusy = true;
		try {
			const r = await lookupCart(code);
			whereOk = r.ok;
			whereLine = r.line;
			whereHit = r.hit;
		} finally {
			whereBusy = false;
			setTimeout(() => (document.getElementById('whereFind') as HTMLInputElement | null)?.select(), 30);
		}
	}

	// ── Barcoded-stage scan-in ──────────────────────────────────────────────
	// Rewritten 2026-09-25 for scanning pace. A barcode gun is a keyboard: it
	// types ~36 characters and hits Enter whether or not the page is ready. The
	// old box disabled itself for the round trip AND awaited invalidateAll()
	// (~25 queries, three of them growing collection scans) before it would take
	// another cart, so keystrokes landing in that window were dropped or
	// truncated. Now: the input is never disabled, Enter drains it instantly onto
	// a queue, one worker posts the queue in order, and the board is corrected
	// locally by an overlay instead of being refetched between carts.
	let cartScan = $state('');
	let cartScanError = $state('');
	let cartScanOk = $state('');
	// Each entry carries its own cycleId: if the operator opens a different bucket
	// while the queue is still draining, carts already scanned still land in the
	// bucket they were scanned into.
	let scanQueue = $state<{ code: string; cycleId: string }[]>([]);
	let scanFailures = $state<{ code: string; error: string }[]>([]);
	let pumping = false;
	// cycleId → ids scanned in / un-scanned since the last server read. Kept as an
	// overlay rather than written into `data` so a refetch can land at any moment:
	// once the server knows an id, the overlay entry for it is a harmless
	// duplicate, so this never needs clearing and can never disagree with `data`.
	let scanAdded = $state<Record<string, string[]>>({});
	let scanRemoved = $state<Record<string, string[]>>({});
	// Queued but not yet confirmed (2026-10-02). The count used to move only when
	// the server confirmed a scan, and scans confirm one at a time — each confirm
	// is a full round trip — so with the gun at a cart a second the card and the
	// stage tile trailed the gun by the length of the queue. A pending id counts
	// exactly like an added one; on confirm it moves to scanAdded, on failure it is
	// dropped, so the count visibly steps back and the code is in "did not take".
	let scanPending = $state<Record<string, string[]>>({});

	function overlay(c: BoardCycle): BoardCycle {
		const added = scanAdded[c.cycleId];
		const pending = scanPending[c.cycleId];
		const removed = scanRemoved[c.cycleId];
		if (!added?.length && !pending?.length && !removed?.length) return c;
		const gone = new Set(removed ?? []);
		const ids = c.cartridgeIds.filter(id => !gone.has(id));
		const seen = new Set(ids);
		for (const id of [...(added ?? []), ...(pending ?? [])]) if (!seen.has(id) && !gone.has(id)) { ids.push(id); seen.add(id); }
		return { ...c, cartridgeIds: ids, quantity: ids.length };
	}
	function settlePending(cycleId: string, code: string) {
		scanPending = { ...scanPending, [cycleId]: (scanPending[cycleId] ?? []).filter(c => c !== code) };
	}
	// Every read of an open pass goes through here, so the card, the rail and the
	// audit's "missing members" list all see the same membership.
	const boardCycles = $derived(data.board.cycles.map(overlay));
	const cyclesByStage = $derived.by(() => {
		const m: Record<BucketStage, BoardCycle[]> = { barcoded: [], unpressed: [], backing: [] };
		for (const c of boardCycles) m[c.stage]?.push(c);
		return m;
	});
	// Board lanes (user, 2026-10-05): Barcoded → Unpressed (waiting) → Unpressed — in
	// process → Backed. The two Unpressed lanes are ONE stage: a pass waits until an
	// operator pulls it with their badge (?/pull — the custody handoff), and only a
	// pulled pass can be marked done. Backed is a narrow column: it is storage.
	type Lane = { key: string; stage: BucketStage; label: string; hint: string; cycles: BoardCycle[] };
	const lanes = $derived.by((): Lane[] => [
		{ key: 'barcoded', stage: 'barcoded', label: labelFor('barcoded'), hint: 'scanning carts in', cycles: cyclesByStage.barcoded },
		{ key: 'unpressed', stage: 'unpressed', label: labelFor('unpressed'), hint: 'waiting to be pulled', cycles: cyclesByStage.unpressed.filter(c => !c.inProcessAt) },
		{ key: 'unpressed_wip', stage: 'unpressed', label: `${labelFor('unpressed')} — in process`, hint: 'badge on, being pressed', cycles: cyclesByStage.unpressed.filter(c => !!c.inProcessAt) },
		{ key: 'backing', stage: 'backing', label: labelFor('backing'), hint: '', cycles: cyclesByStage.backing }
	]);
	const allIdleBuckets = $derived([...data.board.available, ...data.board.quarantined]);

	const panelCycle = $derived.by((): BoardCycle | null => {
		const p = panel;
		if (p.kind !== 'cycle') return null;
		const id = p.cycleId;
		return boardCycles.find(c => c.cycleId === id) ?? null;
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
	// Headline for a bucket card / panel: nickname if it has one (2026-09-30),
	// else the sticker, else the internal id. The id is always shown underneath.
	function nameOf(b: { nickname: string | null; barcode: string | null; bucketId: string }): string {
		return b.nickname ?? shortQr(b.barcode) ?? b.bucketId;
	}
	function resetLists() { discardList = []; scrapList = []; residualList = []; listInput = ''; residualDisposition = ''; residualDest = ''; cartScanError = ''; cartScanOk = ''; scanFailures = []; whereFind = ''; whereLine = ''; whereOk = true; whereHit = null; }

	function openCycle(c: BoardCycle) { panel = { kind: 'cycle', cycleId: c.cycleId, mode: 'view' }; resetLists(); retargetBadge(c.cycleId); if (c.stage === 'barcoded') focusScanEntry(); }
	function setMode(mode: CycleMode) {
		if (panel.kind === 'cycle') panel = { kind: 'cycle', cycleId: panel.cycleId, mode };
		resetLists();
		// Every advance is badge-gated (2026-10-02): land the gun on the badge box
		// when no badge is on yet, so the first scan is the badge, not a cart.
		if (mode === 'advance' && badgeRequired && !badge.trim()) focusBadge();
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
	// Nickname is searchable here (typed "blue" lists "Big Blue") but never an
	// exact match — only an id or sticker opens a panel straight from the box.
	function containsLabel(bucketId: string, barcode: string | null, code: string, nickname: string | null = null): boolean {
		return bucketId.includes(code.toUpperCase()) || (barcode != null && barcode.toLowerCase().includes(code.toLowerCase()))
			|| (nickname != null && nickname.toLowerCase().includes(code.toLowerCase()));
	}
	function resolveLocal(code: string): boolean {
		const raw = code.trim();
		if (!raw) return false;
		const cycle = boardCycles.find(c => matchesLabel(c.bucketId, c.barcode, raw));
		if (cycle) { openCycle(cycle); shortList = []; return true; }
		const bucket = allIdleBuckets.find(b => matchesLabel(b.bucketId, b.barcode, raw));
		if (bucket) { openBucket(bucket); shortList = []; return true; }
		const hits = [
			...boardCycles.filter(c => containsLabel(c.bucketId, c.barcode, raw, c.nickname)).map(c => ({ bucketId: c.bucketId, state: 'in_use', hint: `${c.nickname ? `${c.nickname} · ` : ''}${labelFor(c.stage)} · ${c.quantity}` })),
			...allIdleBuckets.filter(b => containsLabel(b.bucketId, b.barcode, raw, b.nickname)).map(b => ({ bucketId: b.bucketId, state: b.state, hint: `${b.nickname ? `${b.nickname} · ` : ''}${b.state === 'quarantined' ? (b.residualNote ?? 'quarantined') : `available · ${b.cycleCount} passes`}` }))
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

	function labelFor(stage: string): string { return data.stages.find(s => s.key === stage)?.label ?? stage; }
	function nextKey(stage: BucketStage): BucketStage | null {
		const i = data.stages.findIndex(s => s.key === stage);
		return i >= 0 && i < data.stages.length - 1 ? data.stages[i + 1].key : null;
	}
	function nextLabel(stage: BucketStage): string { const k = nextKey(stage); return k ? labelFor(k) : 'Wax filling'; }
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
		if (takeBadge(code)) return; // a badge scanned into a cart list goes to the badge box
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
	/** Where the gun should land on a Barcoded pass: the badge box until a badge is on, then the cart box. */
	function focusScanEntry() { if (badgeRequired && !badge) focusBadge(); else focusCartScan(); }

	// A fast gun can glue two 36-character labels into one read. WI-01 learned
	// this the hard way (87 merged codes became cartridge records before the
	// backstop landed); split and scan each rather than refusing both.
	function splitMerged(raw: string): string[] {
		const v = raw.trim();
		if (v.length <= 36 || v.length % 36 !== 0) return [v];
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		const parts: string[] = [];
		for (let i = 0; i < v.length; i += 36) parts.push(v.slice(i, i + 36));
		return parts.every(p => uuid.test(p)) ? [...new Set(parts)] : [v];
	}

	// The board's read models (change log, registry, per-lot remaining) are too
	// heavy to sit between two carts, but they should not go stale for long
	// either — so one refetch lands after scanning stops, never during it.
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleBoardRefresh() {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			if (scanQueue.length === 0 && !pumping) void invalidateAll();
		}, 2500);
	}

	/** Enter in the scan box: drain it immediately, queue the code, keep the box hot. */
	function enqueueCartScan() {
		const raw = cartScan.trim();
		cartScan = '';
		if (!raw || panel.kind !== 'cycle') return;
		const cycleId = panel.cycleId;
		const codes = splitMerged(raw);
		if (codes.length > 1) cartScanOk = `${codes.length} labels read as one — scanning them separately.`;
		const members = new Set(panelCycle?.cartridgeIds ?? []);
		for (const code of codes) {
			// The badge is usually the first thing scanned, and the gun types into
			// whatever box is focused — so a badge in the cart box is taken as the badge.
			if (takeBadge(code)) { cartScanError = ''; cartScanOk = 'Badge scanned — now scan the carts.'; focusCartScan(); continue; }
			if (badgeRequired && !badge) { cartScanError = 'Scan your badge first, then the carts.'; focusBadge(); continue; }
			// Queued first: a pending id is already a member through the overlay, so
			// the membership check alone would call a double read "already in".
			if (scanQueue.some(q => q.code === code)) { cartScanError = `${code} is already queued.`; continue; }
			if (members.has(code)) { cartScanError = `${code} is already in this bucket.`; continue; }
			cartScanError = '';
			scanQueue = [...scanQueue, { code, cycleId }];
			// Counted now, not when the server answers — the gun does not wait.
			scanPending = { ...scanPending, [cycleId]: [...(scanPending[cycleId] ?? []), code] };
		}
		void pumpCartScans();
	}

	/** One worker drains the queue in scan order; new codes appended mid-flight are picked up. */
	async function pumpCartScans() {
		if (pumping) return;
		pumping = true;
		try {
			while (scanQueue.length > 0) {
				const { code, cycleId } = scanQueue[0];
				try {
					const fd = new FormData();
					fd.set('cycleId', cycleId);
					fd.set('barcode', code);
					fd.set('badge', badge);   // the gated step: every scan-in carries the badge
					const res = await fetch('?/scanIn', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
					const result = deserialize(await res.text());
					if (result.type === 'success') {
						scanAdded = { ...scanAdded, [cycleId]: [...(scanAdded[cycleId] ?? []), code] };
						scanRemoved = { ...scanRemoved, [cycleId]: (scanRemoved[cycleId] ?? []).filter(c => c !== code) };
						cartScanOk = `${code} scanned in`;
						const who = (result.data as any)?.scanIn?.operator;
						if (typeof who === 'string') scanOperator = who;
					} else {
						const msg = result.type === 'failure'
							? ((result.data as any)?.scanIn?.error ?? `Error ${result.status}`)
							: (result.type === 'error' ? (result.error?.message ?? 'Scan failed') : 'Scan failed');
						// Queued scans must never fail silently: the next cart's
						// success would overwrite a single error line, so failures
						// stack up under the box until they are dismissed.
						scanFailures = [...scanFailures, { code, error: msg }];
						cartScanError = msg;
						// A refused badge (unknown, revoked, not allowed) is cleared so the
						// next scan into the badge box replaces it rather than appending.
						const errCode = result.type === 'failure' ? (result.data as any)?.scanIn?.code : null;
						if (typeof errCode === 'string' && errCode.startsWith('BADGE') && errCode !== 'BADGE') { badge = ''; scanOperator = ''; focusBadge(); }
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : 'Scan failed';
					scanFailures = [...scanFailures, { code, error: msg }];
					cartScanError = msg;
				}
				// Confirmed ids are in scanAdded by now; failed ones leave the count.
				settlePending(cycleId, code);
				scanQueue = scanQueue.slice(1); // codes appended while that POST ran are kept
			}
		} finally {
			pumping = false;
			scheduleBoardRefresh();
		}
	}

	async function unscanCartFromBucket(code: string) {
		if (panel.kind !== 'cycle') return;
		const cycleId = panel.cycleId;
		cartScanError = ''; cartScanOk = '';
		// Gated step (2026-10-05): taking a cart back out needs the badge too.
		if (badgeRequired && !badge) { cartScanError = 'Scan your badge first, then remove the cart.'; focusBadge(); return; }
		try {
			const fd = new FormData();
			fd.set('cycleId', cycleId);
			fd.set('barcode', code);
			fd.set('badge', badge);
			const res = await fetch('?/unscan', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				scanRemoved = { ...scanRemoved, [cycleId]: [...(scanRemoved[cycleId] ?? []), code] };
				scanAdded = { ...scanAdded, [cycleId]: (scanAdded[cycleId] ?? []).filter(c => c !== code) };
				cartScanOk = `${code} removed`;
				scheduleBoardRefresh();
			} else if (result.type === 'failure') {
				cartScanError = (result.data as any)?.unscan?.error ?? `Error ${result.status}`;
				const errCode = (result.data as any)?.unscan?.code;
				if (typeof errCode === 'string' && errCode.startsWith('BADGE') && errCode !== 'BADGE') { badge = ''; scanOperator = ''; focusBadge(); }
			}
			// The mis-scan button used to have no branch here at all, so the 500 the
			// sacred delete hook threw showed the operator nothing (fixed 2026-09-25
			// along with the hook itself).
			else if (result.type === 'error') cartScanError = result.error?.message ?? 'Removing that cart failed';
			else cartScanError = 'Removing that cart failed';
		} catch (e) {
			cartScanError = e instanceof Error ? e.message : 'Removing that cart failed';
		}
	}

	// React to each action result exactly once (form keeps the last result).
	let handledForm: unknown = null;
	$effect(() => {
		if (!form || form === handledForm) return;
		handledForm = form;
		if (form.advance?.success || form.scrap?.success) { if (panel.kind === 'cycle') setMode('view'); }
		// Every lane change is a handoff: the next step takes a fresh badge scan, so the
		// badge that marked a bucket done never rides into the pull that follows.
		if (form.advance?.success) { badge = ''; scanOperator = ''; badgeFor = null; }
		if (form.pull?.success && panel.kind === 'cycle') setMode('view');
		if (form.audit?.success) { resetAudit(); if (panel.kind === 'cycle') setMode('view'); }
		if (form.start?.success && typeof form.start.cycleId === 'string') {
			// The badge that started this pass is this pass's badge: re-key it to the
			// new pass so the cart scans that follow do not ask for it a second time.
			if (badge) badgeFor = form.start.cycleId;
			panel = { kind: 'cycle', cycleId: form.start.cycleId, mode: 'view' }; resetLists(); focusScanEntry();
		}
		if (form.residual?.success || form.retire?.success) { panel = { kind: 'none' }; resetLists(); }
		// A gated form refused the badge: clear it so the next badge scan replaces it.
		for (const r of [form.start, form.advance, form.pull, form.scrap, form.moveToOven, form.audit, form.residual, form.retire]) {
			if (r && typeof r.code === 'string' && r.code.startsWith('BADGE') && r.code !== 'BADGE') { badge = ''; scanOperator = ''; focusBadge(); }
		}
	});

	const enhanceBusy = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => { await update({ reset: false }); busy = false; };
	};

	// ── "In oven" — copy every id (user, 2026-10-05) ─────────────────────────
	// The dropdown shows the first 200 ids as links; this fetches the whole list
	// and puts it, one id per line, on the clipboard and in a box (the same shape
	// State Change's cart box takes). Read-only.
	let ovenIdsText = $state('');
	let ovenIdsMsg = $state('');
	let ovenIdsBusy = $state(false);
	async function copyAllInOven() {
		ovenIdsBusy = true; ovenIdsMsg = '';
		try {
			const res = await fetch('?/inOvenList', { method: 'POST', body: new FormData(), headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type !== 'success') {
				ovenIdsMsg = result.type === 'failure' ? ((result.data as any)?.inOvenList?.error ?? `Error ${result.status}`) : 'Could not load the list.';
				return;
			}
			const r = (result.data as any)?.inOvenList as { count: number; ids: string[] };
			ovenIdsText = r.ids.join('\n');
			const short = r.count > r.ids.length ? ` (first ${r.ids.length} of ${r.count})` : '';
			try {
				await navigator.clipboard.writeText(ovenIdsText);
				ovenIdsMsg = `${r.ids.length} id${r.ids.length === 1 ? '' : 's'} copied${short}.`;
			} catch {
				// Clipboard blocked (permissions, older browser): the box below still has them.
				ovenIdsMsg = `${r.ids.length} id${r.ids.length === 1 ? '' : 's'} listed below${short} — select and copy.`;
			}
		} catch (e) {
			ovenIdsMsg = e instanceof Error ? e.message : 'Could not load the list.';
		} finally {
			ovenIdsBusy = false;
		}
	}

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
			case 'consume': return { event: 'Drawn to wax filling', moved: `${from ?? data.backedLabel} → wax filling`, discarded: false };
			case 'oven': return { event: 'Moved to oven', moved: `${from ?? data.backedLabel} → oven (carts released from the bucket)`, discarded: false };
			case 'pull': return { event: 'Pulled into process', moved: `${from ?? 'Unpressed'} → in process (badge handoff)`, discarded: false };
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
		return data.registry.filter(r => (regState === 'all' || r.state === regState) && (!q || r.bucketId.toLowerCase().includes(q) || (r.barcode ?? '').toLowerCase().includes(q) || (r.nickname ?? '').toLowerCase().includes(q)));
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
	const stageTint: Record<string, string> = { available: 'border-[var(--color-tron-border)]', barcoded: 'border-gray-500/40', unpressed: 'border-blue-500/40', backing: 'border-[var(--color-tron-purple)]/50' };
</script>

{#snippet badgeField(show: boolean, next?: () => void)}
	<!-- The badge box for a gated step. `show` = this submission needs a badge
	     (e.g. an advance only when carts are discarded). When it is not needed, or
	     enforcement is off, the badge already scanned still rides along hidden so a
	     scan made anyway is honoured. Enter never submits — the gun sends one. -->
	{#if show && badgeRequired}
		<label class="block">
			<span class="text-[10px] uppercase tracking-wider {badge.trim() ? 'text-[var(--color-tron-text-secondary)]' : 'text-[var(--color-tron-cyan)]'}">Scan your badge{#if badge.trim()} <span class="normal-case tracking-normal text-green-300">· on</span>{/if}</span>
			<input id="badgeScan" type="text" name="badge" bind:value={badge} required autocomplete="off" placeholder="scan badge…"
				onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); badge = badge.trim(); badgeFor = panelKey; scanOperator = ''; next?.(); } }}
				class="{inputCls} font-mono {badge.trim() ? '' : 'border-[var(--color-tron-cyan)]/60 ring-1 ring-[var(--color-tron-cyan)]/30'}" />
		</label>
	{:else}
		<input type="hidden" name="badge" value={badge} />
	{/if}
{/snippet}

{#snippet cartHitView(h: CartHit)}
	<!-- One found cart (Find a cart box + leftover "where does it belong?"):
	     cart id · status pill · where it is, headlined by the bucket's nickname
	     (the way board cards are), with the bucket's state pill from the bucket
	     log. Read-only — the bucket link is the only thing to click. -->
	<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
		<span class="font-mono text-[var(--color-tron-text)]">{h.cartridgeId}</span>
		<span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider {cartStatusTint[h.status ?? ''] ?? cartStatusTintDefault}">{h.statusLabel ?? h.status ?? '—'}</span>
		{#if h.home}
			<span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider {relationTint[h.home.relation]}">{relationLabel[h.home.relation]}</span>
			<a href="/manufacturing/cart-mfg/buckets/{h.home.bucketId}" class="text-[var(--color-tron-cyan)] hover:underline" title={h.home.barcode ?? h.home.bucketId}>
				{#if h.home.nickname}<span class="font-medium">{h.home.nickname}</span> <span class="font-mono text-[var(--color-tron-text-secondary)]">{h.home.bucketId}</span>{:else}<span class="font-mono">{h.home.bucketId}</span>{/if}
				<span class="font-mono text-[var(--color-tron-text-secondary)]">#{h.home.cycleNumber}</span>
			</a>
			<span class="text-[var(--color-tron-text-secondary)]">at {stageLabel(h.home.stage)}</span>
			{#if h.home.bucketState}<span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider {regStateTint[h.home.bucketState] ?? ''}">bucket {regStateLabel[h.home.bucketState] ?? h.home.bucketState}</span>{/if}
		{:else if h.status && cartStatusTint[h.status]}
			<span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider {relationTint.taken_off}">On no open pass</span>
		{/if}
		{#if h.legacyLotId}<span class="text-[var(--color-tron-text-secondary)]">WI-01 lot <span class="font-mono">{h.legacyLotId}</span> (legacy)</span>{/if}
		{#if h.since}<span class="font-mono text-[10px] text-[var(--color-tron-text-secondary)]">since {fmtAt(h.since)}</span>{/if}
	</div>
{/snippet}

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
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Stick a QR on each shell and scan it into a bucket. Mark a Barcoded bucket <em>Done</em> and it waits in Unpressed; an operator <em>pulls</em> it into in process with their badge, then marks it Done → {data.backedLabel}. <em>Move to oven</em> frees the carts and returns the bucket to Available.</p>
		</div>
		<div class="flex gap-2">
			<a href="/manufacturing/cart-mfg/buckets/new" class={btnGhost}>New bucket</a>
			{#if data.canAdmin}<a href="/manufacturing/cart-mfg/buckets/override" class="rounded border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/20" title="Move a bucket to any phase, bypassing the flow (admin)">Master override</a>{/if}
			<a href="/manufacturing/cart-mfg/state-change" class={btnGhost} title="Move individual carts to any status (bucket stages ask for a destination bucket)">Cart state change</a>
			<!-- Badge Portal link (BADGE-SYSTEM_PLAN.md §17.5): the Require-badge switch lives
			     there; this only shows to someone the portal will let in. -->
			{#if data.canBadgeAdmin}<a href="/admin/badges" class="rounded border px-3 py-1.5 text-xs {data.badgeMode === 'required' ? 'border-[var(--color-tron-cyan)]/40 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10' : 'border-[var(--color-tron-yellow)]/40 text-[var(--color-tron-yellow)] hover:bg-[var(--color-tron-yellow)]/10'}" title="Open the Badge Portal to change whether scan-in, every advance, discards and move to oven require a badge (admin)">Badge required: {data.badgeMode === 'required' ? 'on' : 'off'}</a>{/if}
			<a href="/manufacturing/cart-mfg/wax-filling" class={btnGhost}>Wax filling →</a>
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

	<!-- Controls strip (user, 2026-10-05): what used to be the right-hand rail, laid
	     across the top where the counter tiles were, so the lanes get the full width. -->
	<section class="grid items-start gap-3 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
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
						{#if data.scan.kind === 'badge'}
							{#if data.scan.badge?.displayName}
								<p class="text-[var(--color-tron-text)]">That is <strong>{data.scan.badge.displayName}</strong>'s badge{data.scan.badge.username ? ` (${data.scan.badge.username})` : ''} — scan a bucket here. Badges go in the badge box when you scan carts into a bucket, advance it a phase, discard carts, or move it to the oven.</p>
							{:else}
								<p class="text-[var(--color-tron-yellow)]">{data.scan.badge?.note ?? 'Unknown badge.'}</p>
							{/if}
						{:else if data.scan.kind === 'bucket'}
							<div class="flex items-center justify-between"><span class="font-mono text-[var(--color-tron-text)]">{#if data.scan.bucket.nickname}<span class="font-sans">{data.scan.bucket.nickname}</span> · {/if}{data.scan.bucket._id}</span><span class="text-[10px] uppercase text-[var(--color-tron-text-secondary)]">{data.scan.bucket.state} · {data.scan.bucket.cycleCount} passes</span></div>
							<a href="/manufacturing/cart-mfg/buckets/{data.scan.bucket._id}" class="mt-1 block text-[var(--color-tron-cyan)] hover:underline">Open history →</a>
						{:else if (data.scan.matches ?? []).length === 0}
							<p class="text-[var(--color-tron-text-secondary)]">No bucket matches “{data.scanQuery}”.</p>
						{:else}
							<ul class="space-y-1">{#each data.scan.matches ?? [] as m (m.bucketId)}<li class="flex items-center justify-between"><a href="/manufacturing/cart-mfg/buckets/{m.bucketId}" class="font-mono text-[var(--color-tron-cyan)] hover:underline">{m.bucketId}{#if m.nickname} <span class="font-sans text-[var(--color-tron-text)]">· {m.nickname}</span>{/if}</a><span class="text-[10px] text-[var(--color-tron-text-secondary)]">{m.cycle ? `${labelFor(m.cycle.stage)} · ${m.cycle.quantity}` : m.state}</span></li>{/each}</ul>
						{/if}
					</div>
				{/if}
			</div>

			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 {panel.kind === 'cycle' ? '' : 'lg:max-w-2xl'}">
				{#if panel.kind === 'none'}
					<p class="py-6 text-center text-xs text-[var(--color-tron-text-secondary)]">Scan a bucket or pick a card.</p>

				{:else if panel.kind === 'cycle'}
					{#if !panelCycle}
						{#if form?.moveToOven?.success}
							{@const m = form.moveToOven as any}
							<div class="rounded border border-[var(--color-tron-purple)]/60 bg-[var(--color-tron-purple)]/10 p-2 text-xs text-[var(--color-tron-text)]" role="status">
								<strong class="text-[var(--color-tron-purple)]">Moved to oven.</strong> {m.released} cart{m.released === 1 ? '' : 's'} freed from {m.bucketId} #{m.cycleNumber}{#if m.operator} by <strong>{m.operator}</strong>{/if}; the bucket is back in Available. They stay backed (see <em>In oven</em> under Backed) until <a href="/manufacturing/cart-mfg/wax-filling" class="underline">wax filling</a> scans them.
							</div>
						{:else}
							<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">This pass is no longer on the board (moved to the oven, drawn to wax filling, emptied, or refreshing).</p>
						{/if}
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Close</button>
					{:else}
						{@const c = panelCycle}
						{@const nxt = nextKey(c.stage)}
						<div class="lg:grid lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-5">
						<div>
						<div class="flex items-start justify-between">
							<div>
								<div class="font-mono text-lg text-[var(--color-tron-text)]">{nameOf(c)}</div>
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

						{#if c.stage === 'unpressed'}
							<p class="mt-2 text-[10px] {c.inProcessAt ? 'text-green-300' : 'text-[var(--color-tron-yellow)]'}">{c.inProcessAt ? `In process${c.inProcessBy ? ` · ${c.inProcessBy}` : ''} · pulled ${dwell(c.inProcessAt)} ago` : 'Waiting — not pulled into in process yet'}</p>
						{/if}
						</div>
						<div>
						{#if panel.mode === 'view'}
							{#if c.stage === 'barcoded'}
								<!-- Barcoded = filling. Scan shells in; each scan is a cartridge's birth.
								     Gated step (2026-09-30): badge first, then carts — the badge rides on
								     every scan-in POST, and a badge scanned into the cart box is routed up. -->
								<div class="mt-3 space-y-2">
									{@render badgeField(true, focusCartScan)}
									{#if scanOperator}
										<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Carts are being recorded to <strong class="text-[var(--color-tron-text)]">{scanOperator}</strong>. <button type="button" onclick={clearBadge} class="underline hover:text-[var(--color-tron-text)]">Change badge</button></p>
									{:else if badgeRequired && !badge.trim()}
										<p class="text-[10px] text-[var(--color-tron-yellow)]">Scan your badge first — cart scans are held until it is on.</p>
									{/if}
								</div>
								<div class="mt-3">
									<label for="cartScan" class="text-[10px] uppercase tracking-wider text-[var(--color-tron-cyan)]">Scan carts into this bucket</label>
									<!-- Never disabled: a disabled input loses focus, and the gun keeps
									     typing regardless. Enter queues and returns immediately. -->
									<input id="cartScan" type="text" bind:value={cartScan} autocomplete="off" placeholder="scan cart QR…"
										onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); enqueueCartScan(); } }} class={scanCls} />
									{#if scanQueue.length > 0}
										<p class="mt-1 text-[10px] text-[var(--color-tron-cyan)]">Recording… {scanQueue.length} queued — keep scanning</p>
									{/if}
									{#if cartScanOk}<p class="mt-1 text-[10px] text-green-300">{cartScanOk}</p>{/if}
									{#if cartScanError && scanFailures.length === 0}<p class="mt-1 text-xs text-[var(--color-tron-error)]">{cartScanError}</p>{/if}
									{#if scanFailures.length > 0}
										<div class="mt-1 rounded border border-[var(--color-tron-error)]/50 bg-[var(--color-tron-error)]/10 p-1.5">
											<div class="flex items-center justify-between">
												<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-error)]">{scanFailures.length} scan{scanFailures.length === 1 ? '' : 's'} did not take</span>
												<button type="button" onclick={() => { scanFailures = []; cartScanError = ''; }} class="text-[10px] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">dismiss</button>
											</div>
											<ul class="mt-1 space-y-0.5">
												{#each scanFailures as f, i (f.code + i)}
													<li class="text-[10px] text-[var(--color-tron-error)]"><span class="font-mono">{f.code}</span> — {f.error}</li>
												{/each}
											</ul>
										</div>
									{/if}
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
								{#if c.stage === 'unpressed' && !c.inProcessAt}
									<!-- Waiting lane: nothing can be done to the bucket until someone takes it.
									     The pull is the badge handoff (2026-10-05) — it is recorded to this badge
									     from here until the bucket is marked done. -->
									<form method="POST" action="?/pull" use:enhance={enhanceBusy} class="space-y-2">
										<input type="hidden" name="cycleId" value={c.cycleId} />
										<p class="text-xs text-[var(--color-tron-text-secondary)]">This bucket is waiting. {#if badgeRequired}Scan your badge to take it{:else}Take it{/if} into <strong class="text-[var(--color-tron-text)]">in process</strong> — it is recorded to you from here.</p>
										{@render badgeField(true)}
										{#if form?.pull?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.pull.error}</p>{/if}
										<button type="submit" disabled={busy} class={btnPrimary}>{busy ? 'Pulling…' : 'Pull into in process'}</button>
									</form>
								{:else if nxt}
									<button type="button" class={btnPrimary} disabled={c.quantity === 0} onclick={() => setMode('advance')}>Done → {nextLabel(c.stage)}</button>
								{:else}
									<!-- Backed is the end of the bucket. Move to oven frees the carts from the bucket
									     and returns it to Available — nothing else (user, 2026-09-25). -->
									<form method="POST" action="?/moveToOven" use:enhance={enhanceBusy} class="space-y-2">
										<input type="hidden" name="cycleId" value={c.cycleId} />
										<!-- Gated step (2026-09-30): passing carts to the oven needs a badge. -->
										{@render badgeField(true)}
										<button type="submit" disabled={busy || c.quantity === 0}
											class="w-full rounded-lg border border-[var(--color-tron-purple)]/60 bg-[var(--color-tron-purple)]/10 py-2.5 text-center text-sm font-semibold text-[var(--color-tron-purple)] hover:bg-[var(--color-tron-purple)]/20 disabled:opacity-50"
											title="Free the carts from this bucket and return it to Available; the carts stay backed until wax filling scans them">{busy ? 'Moving…' : `Move to oven (${c.quantity} cart${c.quantity === 1 ? '' : 's'})`}</button>
									</form>
									<p class="text-[10px] text-[var(--color-tron-text-secondary)]">Frees these carts from the bucket and returns it to Available. Carts stay backed until wax filling scans them in.</p>
									{#if form?.moveToOven?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.moveToOven.error}</p>{/if}
									<a href="/manufacturing/cart-mfg/wax-filling" class="block text-center text-[10px] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">Wax filling →</a>
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
								<!-- Gated step (2026-10-02, "require a scan in at every phase"): every advance
								     needs a badge, discards or not. Before this it was asked only when the
								     discard list was non-empty. -->
								{@render badgeField(true)}
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
								<!-- Gated step (2026-09-30): discarding carts needs a badge. -->
								{@render badgeField(true)}
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
								<!-- Gated step (2026-09-30): an audit that discards a stray or writes a
								     missing member off is discarding carts, so it needs a badge; moves and
								     take-offs do not. -->
								{@render badgeField(auditDiscards.length > 0 || auditMissingActions.some(m => m.action === 'discard'))}
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
						</div>
						</div>
					{/if}

				{:else if !panelBucket}
					<p class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">This bucket is no longer idle (its pass started, or the board is refreshing).</p>
					<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'none' }; }}>Close</button>

				{:else if panel.kind === 'start'}
					{@const b = panelBucket}
					<div class="flex items-start justify-between">
						<div>
							<div class="font-mono text-lg text-[var(--color-tron-text)]">{nameOf(b)}</div>
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
							<p class="text-xs text-[var(--color-tron-text-secondary)]">{#if badgeRequired}Scan your badge, pick{:else}Pick{/if} the shell lot this pass draws from, then scan the shells in one at a time.</p>
							<!-- Gated step again (2026-10-05; it was ungated from 2026-09-30): starting a
							     pass needs a badge. The same badge then carries on to the cart scans. -->
							{@render badgeField(true)}
							<label class="block">
								<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Shell lot (PT-CT-104)</span>
								<select name="shellLotId" required class={inputCls}>
									<option value="">{(data.lots['PT-CT-104'] ?? []).length ? '— Select lot —' : 'No shell lots available'}</option>
									{#each data.lots['PT-CT-104'] ?? [] as l (l.lotId)}<option value={l.lotId}>{l.lotId} — {l.remaining} left</option>{/each}
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
						<div class="font-mono text-lg text-[var(--color-tron-text)]">{nameOf(b)}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">leftover carts found in this bucket</div>
					</div>

					<!-- 0. Where does this cart belong? (user, 2026-09-25) Scan a leftover and
					     get one line back: the open pass it is a member of, or that it is on
					     none. Read-only — it does not add the cart to the list below. -->
					<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-2">
						<label for="whereFind" class="block text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Where does this cart belong?</label>
						<div class="mt-1 flex gap-2">
							<input id="whereFind" type="text" bind:value={whereFind} autocomplete="off" disabled={whereBusy}
								placeholder="scan a cart to locate it…"
								onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findWhere(); } }} class={scanCls} />
							<button type="button" onclick={findWhere} disabled={whereBusy || !whereFind.trim()}
								class="shrink-0 rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 text-xs font-medium text-[var(--color-tron-cyan)] disabled:opacity-50">{whereBusy ? '…' : 'Find'}</button>
						</div>
						{#if whereHit}
							<div class="mt-1">{@render cartHitView(whereHit)}</div>
						{:else if whereLine}
							<p class="mt-1 text-xs {whereOk ? 'text-[var(--color-tron-text)]' : 'text-[var(--color-tron-yellow)]'}">{whereLine}</p>
						{/if}
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
						<!-- Gated step (2026-09-30): discarding leftovers needs a badge; merging does not. -->
						{@render badgeField(residualDisposition === 'scrap')}

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
						<p class="font-mono text-lg text-[var(--color-tron-text)]">{nameOf(b)}</p>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Retiring is permanent; the bucket's history stays.</p>
						<label class="block"><span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Reason (required)</span><input type="text" name="reason" required class={inputCls} /></label>
						<!-- Gated step (2026-10-05): retiring needs a badge whose holder is a bucket admin. -->
						{@render badgeField(true)}
						{#if form?.retire?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.retire.error}</p>{/if}
						<button type="submit" disabled={busy} class={btnDanger}>Retire bucket</button>
						<button type="button" class={btnGhost} onclick={() => { panel = { kind: 'start', bucketId: b.bucketId, step: 'form' }; }}>Cancel</button>
					</form>
				{/if}
			</div>
	</section>

		<!-- Board: Available + four lanes — Barcoded, Unpressed (waiting), Unpressed — in process, and a narrow Backed (user, 2026-10-05). -->
		<div class="grid grid-cols-1 gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,0.7fr)]">
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
									<span class="font-mono text-sm text-[var(--color-tron-text)]">{nameOf(b)}</span>
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
								<span class="font-mono text-sm text-[var(--color-tron-text)]">{nameOf(b)}</span>
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

			{#each lanes as s (s.key)}
				<div class="rounded-lg border bg-[var(--color-tron-bg-secondary)] p-2 {data.focusStage === s.stage ? 'ring-1 ring-[var(--color-tron-cyan)]' : ''} {stageTint[s.stage]}">
					<div class="flex items-center justify-between px-1 pb-2">
						<span class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">{s.label}{#if s.hint} <span class="font-normal normal-case tracking-normal opacity-70">· {s.hint}</span>{/if}</span>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">{s.cycles.length}</span>
					</div>
					<div class="space-y-2">
						{#each s.cycles as c (c.cycleId)}
							<!-- Card = open-the-panel button + an expandable list of the carts inside
							     (a sibling <details>, not nested in the button). -->
							<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] hover:border-[var(--color-tron-cyan)]/60 {panel.kind === 'cycle' && panel.cycleId === c.cycleId ? 'ring-1 ring-[var(--color-tron-cyan)]' : ''}">
								<button type="button" onclick={() => openCycle(c)} class="w-full p-2 text-left">
									<div class="flex items-baseline justify-between">
										<span class="font-mono text-sm text-[var(--color-tron-text)]">{nameOf(c)}</span>
										<span class="text-lg font-bold text-[var(--color-tron-cyan)]">{c.quantity}</span>
									</div>
									<div class="mt-1 flex items-center justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
										<span>{c.bucketId} #{c.cycleNumber} · {dwell(c.inProcessAt ?? c.stageEnteredAt)}{#if c.inProcessBy} · {c.inProcessBy}{/if}</span>
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
						{#if s.cycles.length === 0}
							<p class="px-1 py-4 text-center text-[10px] text-[var(--color-tron-text-secondary)]">empty</p>
						{/if}
						{#if s.key === 'backing'}
							<!-- "In oven": backed carts freed from their bucket (Move to oven), still 'backing'
							     until wax filling scans them in. A dropdown here, not a card (user, 2026-09-25). -->
							<details class="rounded border border-dashed border-[var(--color-tron-purple)]/40 px-2 py-1">
								<summary class="cursor-pointer select-none text-[10px] uppercase tracking-wider text-[var(--color-tron-purple)] hover:text-[var(--color-tron-text)]">In oven · {data.inOven.count} cart{data.inOven.count === 1 ? '' : 's'}</summary>
								{#if data.inOven.count === 0}
									<p class="py-1 text-[10px] text-[var(--color-tron-text-secondary)]">none — carts land here when a Backed bucket is moved to the oven, and leave when wax filling scans them.</p>
								{:else}
									<ul class="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
										{#each data.inOven.ids as id (id)}
											<li><a href="/cartridge-admin?search={encodeURIComponent(id)}" class="block truncate font-mono text-[10px] text-[var(--color-tron-text)] hover:text-[var(--color-tron-cyan)]" title={id}>{id}</a></li>
										{/each}
									</ul>
									{#if data.inOven.count > data.inOven.ids.length}<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">+{data.inOven.count - data.inOven.ids.length} more</p>{/if}
									<!-- Every id, not just the first 200 shown above — one per line. -->
									<button type="button" onclick={copyAllInOven} disabled={ovenIdsBusy}
										class="mt-1 text-[10px] uppercase tracking-wider text-[var(--color-tron-cyan)]/80 hover:text-[var(--color-tron-cyan)] disabled:opacity-50">{ovenIdsBusy ? 'Loading…' : `Copy all ${data.inOven.count} ids`}</button>
									{#if ovenIdsMsg}<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">{ovenIdsMsg}</p>{/if}
									{#if ovenIdsText}
										<textarea readonly rows="6" value={ovenIdsText} onfocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
											class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-2 py-1 font-mono text-[10px] text-[var(--color-tron-text)]"></textarea>
									{/if}
								{/if}
							</details>
						{/if}
					</div>

					{#if s.key === 'unpressed_wip' && data.thermoseal}
						{@const ts = data.thermoseal}
						{@const pct = ts.roll ? Math.max(0, Math.min(100, Math.round((ts.roll.remainingCm / ts.roll.lengthCm) * 100))) : 0}
						<!-- Thermoseal lives under Unpressed because that is where it is consumed (v2 §3.4).
						     One part, counted in rolls; the roll pull here is the only thing that moves it. -->
						<div class="mt-3 rounded border {ts.belowFloor ? 'border-red-500/60' : 'border-[var(--color-tron-border)]'} bg-[var(--color-tron-surface)] p-2 text-[10px]">
							<div class="flex items-center justify-between">
								<span class="font-semibold uppercase tracking-wider text-[var(--color-tron-cyan)]">Thermoseal {ts.partNumber}</span>
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
									<p class="text-[var(--color-tron-text-secondary)]">min {ts.minRolls} · live {ts.partNumber} count</p>
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
							<!-- Development settings (admin): notifications toggle -->
							<details class="mt-2">
								<summary class="cursor-pointer text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Development settings</summary>
								<form method="POST" action="?/thermosealToggles" use:enhance={enhanceBusy} class="mt-1.5 space-y-1.5">
									<label class="flex items-center gap-1.5 {data.canAdmin ? '' : 'opacity-60'}">
										<input type="checkbox" name="notificationsEnabled" value="1" checked={ts.config.notificationsEnabled} disabled={!data.canAdmin || busy} class="accent-[var(--color-tron-cyan)]" />
										<span class="text-[var(--color-tron-text)]">Restock notifications</span>
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
			{#if cartFindHit}
				{@render cartHitView(cartFindHit)}
			{:else if cartFindLine}
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
									{#if r.type === 'consume' && r.relatedId}<span class="font-mono text-[10px]" title="Wax run / legacy WI-01 batch id">{r.relatedId.length > 14 ? r.relatedId.slice(0, 12) + '…' : r.relatedId}</span>{#if r.reason} · {r.reason}{/if}
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
					<thead><tr class="border-b border-[var(--color-tron-border)] text-left text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]"><th class="px-2 py-1">Sticker</th><th class="px-2 py-1">Nickname</th><th class="px-2 py-1">Id</th><th class="px-2 py-1">Status</th><th class="px-2 py-1">Right now</th><th class="px-2 py-1 text-right">Passes</th><th class="px-2 py-1">Last activity</th><th class="px-2 py-1">Created</th></tr></thead>
					<tbody>
						{#each filteredRegistry as r (r.bucketId)}
							<tr class="border-b border-[var(--color-tron-border)]/40 {r.state === 'retired' ? 'opacity-70' : ''}">
								<td class="whitespace-nowrap px-2 py-1 font-mono text-[var(--color-tron-text)]" title={r.barcode ?? ''}>{shortQr(r.barcode) ?? '—'}</td>
								<td class="whitespace-nowrap px-2 py-1 text-[var(--color-tron-text)]">{r.nickname ?? '—'}</td>
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
