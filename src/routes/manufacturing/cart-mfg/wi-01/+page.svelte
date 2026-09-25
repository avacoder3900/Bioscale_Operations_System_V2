<script lang="ts">
	import { deserialize, enhance } from '$app/forms';

	interface RecentLot {
		lotId: string; quantityProduced: number; cartridgeCount?: number; operatorName: string;
		status: string; createdAt: string; finishTime: string | null; bucketBarcode?: string | null; outputLotNumber?: string | null;
	}
	interface PressedBucket {
		bucketId: string; barcode: string | null; cycleId: string; cycleNumber: number; quantity: number; cartridgeIds: string[];
		shellLot: string | null; labelLot: string | null; thermosealLot: string | null;
	}
	interface Props {
		data: {
			config: { processName: string; handoffPrompt: string };
			inOvenLabel: string;
			inOvenCount: number;
			pressedBuckets: PressedBucket[];
			recentLots: RecentLot[];
		};
		form: {
			checkAndStart?: { success?: boolean; lotId?: string; error?: string; resumeLotId?: string; bucketId?: string; cycleId?: string; cycleNumber?: number; members?: string[] };
			confirmComplete?: { success?: boolean; handoffPrompt?: string; error?: string; bucket?: { bucketId: string; label: string; qtyAfter: number; closed: boolean } | null; bucketNotes?: string[] };
			resumeLot?: { success?: boolean; lotId?: string; error?: string; cartridgeIds?: string[]; bucketId?: string | null; cycleId?: string | null; cycleNumber?: number | null; members?: string[] };
			takeAll?: { success?: boolean; error?: string; taken?: string[]; scannedCount?: number };
		} | null;
	}
	let { data, form }: Props = $props();

	// Flow: pick a pressed bucket → scan its carts into the oven (or take all) → confirm
	let step = $state<'config' | 'session' | 'confirm'>('config');

	let bucketScan = $state('');
	let bucketId = $state('');
	let startError = $state('');
	const selectedBucket = $derived(data.pressedBuckets.find((b) => b.bucketId === bucketId) ?? null);
	function applyBucketScan() {
		const raw = bucketScan.trim();
		if (!raw) return;
		const hit = data.pressedBuckets.find((b) => b.bucketId === raw.toUpperCase() || (b.barcode != null && b.barcode.toLowerCase() === raw.toLowerCase()));
		if (hit) { bucketId = hit.bucketId; startError = ''; }
		else startError = `${raw} is not a pressed bucket`;
		bucketScan = '';
	}

	// Session
	let lotId = $state('');
	let batchBucket = $state<{ bucketId: string; cycleNumber: number | null } | null>(null);
	let members = $state<string[]>([]);        // still in the bucket
	let scannedCarts = $state<string[]>([]);   // scanned into the oven this batch
	let cartScanInput = $state('');
	let cartScanError = $state('');
	let cartScanBusy = $state(false);
	let scanArmed = $state(false);
	let takeAllBusy = $state(false);

	// Confirm
	let scrapList = $state<string[]>([]);
	let scrapInput = $state('');
	let scrapReason = $state('');
	let sessionNotes = $state('');
	let handoffOpen = $state(false);
	let handoffPrompt = $state('');

	async function postAction(action: string, fields: Record<string, string>) {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${action}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		return deserialize(await res.text());
	}

	// A fast scanner sometimes delivers two labels as one 72-character string (or the
	// same label twice). Split into UUID-sized chunks, drop repeats, and scan each.
	function splitMerged(raw: string): string[] {
		const v = raw.trim();
		if (v.length <= 36 || v.length % 36 !== 0) return [v];
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		const parts: string[] = [];
		for (let i = 0; i < v.length; i += 36) parts.push(v.slice(i, i + 36));
		return parts.every((p) => uuid.test(p)) ? [...new Set(parts)] : [v];
	}

	async function handleCartScan() {
		const raw = cartScanInput.trim();
		if (!raw || cartScanBusy) return;
		const parts = splitMerged(raw);
		if (parts.length > 1) {
			cartScanInput = '';
			cartScanError = `Two barcodes were read as one — scanning them separately (${parts.length}).`;
			for (const q of parts) { cartScanInput = q; await handleCartScan(); }
			return;
		}
		const barcode = raw;
		if (scannedCarts.includes(barcode)) { cartScanError = `${barcode} already scanned in this batch`; cartScanInput = ''; return; }
		cartScanBusy = true; cartScanError = ''; cartScanInput = '';
		try {
			const result = await postAction('scanBackedCartridge', { lotId, barcode });
			if (result.type === 'success') { scannedCarts = [barcode, ...scannedCarts]; members = members.filter((m) => m !== barcode); }
			else if (result.type === 'failure') cartScanError = (result.data as any)?.scanBackedCartridge?.error ?? `Error ${result.status}`;
			else if (result.type === 'error') cartScanError = result.error?.message ?? 'Scan failed';
		} catch (e) {
			cartScanError = e instanceof Error ? e.message : 'Scan failed';
		} finally {
			cartScanBusy = false;
			document.getElementById('cartScanInput')?.focus();
		}
	}
	async function removeCartScan(barcode: string) {
		cartScanError = '';
		const result = await postAction('removeBackedCartridge', { lotId, barcode });
		if (result.type === 'success') { scannedCarts = scannedCarts.filter((b) => b !== barcode); members = [...members, barcode]; }
		else if (result.type === 'failure') cartScanError = (result.data as any)?.removeBackedCartridge?.error ?? `Error ${result.status}`;
	}
	async function takeAll() {
		if (takeAllBusy || members.length === 0) return;
		takeAllBusy = true; cartScanError = '';
		try {
			const result = await postAction('takeAll', { lotId });
			if (result.type === 'success') { const taken = ((result.data as any)?.takeAll?.taken ?? []) as string[]; scannedCarts = [...taken.slice().reverse(), ...scannedCarts]; members = members.filter((m) => !taken.includes(m)); }
			else if (result.type === 'failure') cartScanError = (result.data as any)?.takeAll?.error ?? `Error ${result.status}`;
		} finally { takeAllBusy = false; }
	}

	function focusScan() { setTimeout(() => document.getElementById('cartScanInput')?.focus(), 60); }
	function armScanning() { scanArmed = true; focusScan(); }
	function handleScanBlur() { if (scanArmed && step === 'session') setTimeout(() => document.getElementById('cartScanInput')?.focus(), 50); }

	function addScrap() {
		const code = scrapInput.trim(); scrapInput = '';
		if (!code) return;
		if (!scannedCarts.includes(code)) { cartScanError = `${code} is not in this batch`; return; }
		if (!scrapList.includes(code)) scrapList = [...scrapList, code];
	}

	let handledForm: unknown = null;
	$effect(() => {
		if (!form || form === handledForm) return;
		handledForm = form;
		if (form.checkAndStart?.success && form.checkAndStart.lotId) {
			const r = form.checkAndStart;
			lotId = r.lotId!;
			batchBucket = { bucketId: r.bucketId ?? bucketId, cycleNumber: r.cycleNumber ?? null };
			members = [...(r.members ?? [])];
			scannedCarts = [];
			step = 'session';
			armScanning();
		}
		if (form.confirmComplete?.success) {
			const r = form.confirmComplete;
			handoffPrompt = r.handoffPrompt ?? 'Backed cartridges ready for wax filling.';
			if (r.bucket) handoffPrompt += r.bucket.closed ? ` Bucket ${r.bucket.bucketId} is empty and back in the available pool.` : ` Bucket ${r.bucket.bucketId} still holds ${r.bucket.qtyAfter} pressed cart${r.bucket.qtyAfter === 1 ? '' : 's'}.`;
			if (Array.isArray(r.bucketNotes) && r.bucketNotes.length) handoffPrompt += ` ${r.bucketNotes.join(' ')}`;
			handoffOpen = true;
		}
		if (form.resumeLot?.success) {
			const r = form.resumeLot;
			lotId = r.lotId!;
			batchBucket = r.bucketId ? { bucketId: r.bucketId, cycleNumber: r.cycleNumber ?? null } : null;
			scannedCarts = [...(r.cartridgeIds ?? [])].reverse();
			members = [...(r.members ?? [])];
			step = 'session';
			armScanning();
		}
	});

	function resetAll() {
		step = 'config'; bucketScan = ''; bucketId = ''; startError = '';
		lotId = ''; batchBucket = null; members = []; scannedCarts = []; cartScanInput = ''; cartScanError = ''; scanArmed = false;
		scrapList = []; scrapInput = ''; scrapReason = ''; sessionNotes = ''; handoffOpen = false; handoffPrompt = '';
	}

	const inputCls = 'mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50';
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">{data.config.processName}</h1>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Pressed bucket → carts into the oven. Carts are already serialized and paid for upstream; nothing is withdrawn here.</p>
		</div>
		<div class="flex items-center gap-3 text-xs">
			<a href="/manufacturing/cart-mfg/buckets" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">← Bucket board</a>
			<span class="rounded border border-[var(--color-tron-purple)]/40 bg-[var(--color-tron-purple)]/10 px-3 py-1.5 text-[var(--color-tron-purple)]"><strong>{data.inOvenCount}</strong> {data.inOvenLabel}</span>
		</div>
	</div>

	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">
		{#if step === 'config'}
			<form method="POST" action="?/checkAndStart" use:enhance>
				<input type="hidden" name="bucketId" value={bucketId} />
				<div class="space-y-4">
					<div>
						<p class="text-lg font-semibold text-[var(--color-tron-text)]">Pick the bucket going into the oven</p>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Only <strong>Pressed</strong> buckets are offered.</p>
					</div>
					{#if selectedBucket}
						<div class="flex items-center justify-between rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 px-3 py-2">
							<div>
								<span class="font-mono text-sm text-[var(--color-tron-text)]">{selectedBucket.barcode ?? selectedBucket.bucketId}</span>
								<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">{selectedBucket.bucketId} #{selectedBucket.cycleNumber} · <strong class="text-[var(--color-tron-text)]">{selectedBucket.quantity}</strong> pressed carts</span>
							</div>
							<button type="button" onclick={() => { bucketId = ''; }} class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-error)]">clear</button>
						</div>
						<div class="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--color-tron-text-secondary)]">
							{#if selectedBucket.shellLot}<span>shell <span class="font-mono text-[var(--color-tron-text)]">{selectedBucket.shellLot}</span></span>{/if}
							{#if selectedBucket.labelLot}<span>label <span class="font-mono text-[var(--color-tron-text)]">{selectedBucket.labelLot}</span></span>{/if}
							{#if selectedBucket.thermosealLot}<span>thermoseal <span class="font-mono text-[var(--color-tron-text)]">{selectedBucket.thermosealLot}</span></span>{/if}
						</div>
					{:else}
						<div class="grid gap-2 sm:grid-cols-2">
							<input type="text" bind:value={bucketScan} autocomplete="off" placeholder="scan the bucket's sticker…" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyBucketScan(); } }} class="{inputCls} border-[var(--color-tron-cyan)]/60 font-mono" />
							<select bind:value={bucketId} class={inputCls}>
								<option value="">{data.pressedBuckets.length ? '— or pick a bucket —' : 'No pressed buckets'}</option>
								{#each data.pressedBuckets as b (b.bucketId)}<option value={b.bucketId}>{b.barcode ? `${b.barcode.slice(0, 8)}… ` : ''}{b.bucketId} #{b.cycleNumber} — {b.quantity} carts</option>{/each}
							</select>
						</div>
					{/if}
					{#if startError || form?.checkAndStart?.error}
						<p class="text-sm text-[var(--color-tron-error)]">{startError || form?.checkAndStart?.error}</p>
						{#if form?.checkAndStart?.resumeLotId}
							<form method="POST" action="?/resumeLot" use:enhance><input type="hidden" name="lotId" value={form.checkAndStart.resumeLotId} /><button type="submit" class="rounded border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-yellow)]">Resume that batch</button></form>
						{/if}
					{/if}
					<button type="submit" disabled={!bucketId} class="w-full rounded-lg bg-[var(--color-tron-cyan)] py-4 text-lg font-bold text-[var(--color-tron-bg-primary)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30">Start session</button>
				</div>
			</form>

			{#each data.recentLots.filter((l) => l.status === 'In Progress') as ipLot (ipLot.lotId)}
				<div class="mt-4 rounded-lg border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/5 p-3">
					<div class="flex items-center justify-between">
						<div><span class="font-mono text-sm text-[var(--color-tron-yellow)]">{ipLot.bucketBarcode ?? ipLot.lotId}</span><span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">{ipLot.operatorName} · {ipLot.cartridgeCount ?? 0} in oven so far</span></div>
						<div class="flex items-center gap-2">
							<form method="POST" action="?/resumeLot" use:enhance><input type="hidden" name="lotId" value={ipLot.lotId} /><button type="submit" class="rounded border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-yellow)]">Resume</button></form>
							<form method="POST" action="?/deleteLot" use:enhance onsubmit={(e) => { if (!confirm(`Discard in-progress batch ${ipLot.lotId}? Scanned carts go back to the bucket.`)) e.preventDefault(); }}><input type="hidden" name="lotId" value={ipLot.lotId} /><button type="submit" class="rounded border border-red-500/50 bg-red-900/20 px-4 py-2 text-sm font-medium text-red-300">Delete</button></form>
						</div>
					</div>
				</div>
			{/each}

		{:else if step === 'session'}
			<div class="space-y-5">
				<div class="text-center">
					<p class="text-lg font-semibold text-[var(--color-tron-text)]">Scan carts into the oven</p>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Each scan moves that cart to <strong>{data.inOvenLabel}</strong> and out of the bucket.</p>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3 text-xs">
					<div class="flex flex-wrap items-center justify-between gap-2 text-[var(--color-tron-text-secondary)]">
						<span>Bucket <span class="font-mono text-[var(--color-tron-cyan)]">{batchBucket?.bucketId ?? '—'}</span>{#if batchBucket?.cycleNumber != null} #{batchBucket.cycleNumber}{/if} · <strong class="text-[var(--color-tron-text)]">{members.length}</strong> still in bucket</span>
						<button type="button" onclick={takeAll} disabled={takeAllBusy || members.length === 0} class="rounded border border-[var(--color-tron-purple)]/50 bg-[var(--color-tron-purple)]/10 px-3 py-1 font-medium text-[var(--color-tron-purple)] disabled:opacity-40">{takeAllBusy ? 'Taking…' : `Take all ${members.length} into the oven`}</button>
					</div>
				</div>
				<div>
					<div class="flex items-center justify-between">
						<label for="cartScanInput" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Scan cartridge</label>
						{#if scanArmed}<span class="flex items-center gap-2 text-xs font-medium text-[var(--color-tron-cyan)]"><span class="flex items-center gap-1.5"><span class="h-2 w-2 animate-pulse rounded-full bg-[var(--color-tron-cyan)]"></span>Scanning active</span><button type="button" onclick={() => (scanArmed = false)} class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[var(--color-tron-text-secondary)]">Pause</button></span>{:else}<button type="button" onclick={armScanning} class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1 text-xs font-medium text-[var(--color-tron-cyan)]">Start scanning</button>{/if}
					</div>
					<input type="text" id="cartScanInput" bind:value={cartScanInput} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCartScan(); } }} onblur={handleScanBlur} onfocus={() => (scanArmed = true)} placeholder={scanArmed ? 'Scan cartridge… (mode active)' : 'Click here or “Start scanning”'} autocomplete="off"
						class="mt-1 w-full rounded border bg-[var(--color-tron-bg-primary)] px-3 py-3 font-mono text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:outline-none {scanArmed ? 'border-[var(--color-tron-cyan)] ring-1 ring-[var(--color-tron-cyan)]/40' : 'border-[var(--color-tron-cyan)]/50'}" />
					{#if cartScanBusy}<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Recording…</p>{/if}
					{#if cartScanError}<p class="mt-1 text-sm text-[var(--color-tron-error)]">{cartScanError}</p>{/if}
				</div>
				<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3">
					<div class="flex items-center justify-between"><p class="text-xs text-[var(--color-tron-text-secondary)]">In the oven</p><p class="text-sm font-bold text-[var(--color-tron-cyan)]">{scannedCarts.length}</p></div>
					{#if scannedCarts.length > 0}
						<ul class="mt-2 max-h-60 space-y-1 overflow-y-auto">
							{#each scannedCarts as barcode (barcode)}<li class="flex items-center justify-between rounded bg-[var(--color-tron-surface)] px-2 py-1"><span class="font-mono text-xs text-[var(--color-tron-text)]">{barcode}</span><button type="button" onclick={() => removeCartScan(barcode)} class="text-xs text-[var(--color-tron-error)] hover:underline">Remove</button></li>{/each}
						</ul>
					{/if}
				</div>
				<div class="flex justify-center gap-3 pt-2">
					<button type="button" disabled={scannedCarts.length === 0} onclick={() => { step = 'confirm'; }} class="rounded-lg bg-green-600 px-6 py-3 font-bold text-white hover:bg-green-500 disabled:opacity-40">Finish session</button>
				</div>
			</div>

		{:else if step === 'confirm'}
			<form method="POST" action="?/confirmComplete" use:enhance>
				<input type="hidden" name="lotId" value={lotId} />
				<input type="hidden" name="notes" value={sessionNotes} />
				<input type="hidden" name="scrapIds" value={scrapList.join(',')} />
				<div class="space-y-5">
					<div class="text-center">
						<p class="text-lg font-semibold text-[var(--color-tron-text)]">Carts in the oven</p>
						<p class="mt-2 text-4xl font-bold text-[var(--color-tron-cyan)]">{scannedCarts.length}</p>
						<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">Go back to scan more or remove mis-scans</p>
					</div>
					<div>
						<p class="text-lg font-semibold text-[var(--color-tron-text)]">Any scrapped at the oven door?</p>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">Scan each scrapped cart. It's discarded from the bucket and its shell, label and thermoseal come out of inventory.</p>
						<input type="text" bind:value={scrapInput} autocomplete="off" placeholder="scan a scrapped cart…" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addScrap(); } }} class="{inputCls} font-mono" />
						{#if scrapList.length > 0}
							<ul class="mt-2 space-y-1">{#each scrapList as code (code)}<li class="flex items-center justify-between rounded bg-[var(--color-tron-bg-primary)] px-2 py-1"><span class="font-mono text-xs text-[var(--color-tron-text)]">{code}</span><button type="button" onclick={() => (scrapList = scrapList.filter((c) => c !== code))} class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-error)]">remove</button></li>{/each}</ul>
							<label for="scrapReason" class="mt-3 block text-xs font-medium text-red-300">Scrap reason (required)</label>
							<input type="text" id="scrapReason" name="scrapReason" bind:value={scrapReason} required placeholder="Why were these scrapped?" class={inputCls} />
						{/if}
					</div>
					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3 text-center text-[10px] text-[var(--color-tron-cyan)]">Nothing is withdrawn from inventory here — shells, labels and thermoseal were consumed in the bucket.</div>
					<div><label for="notes" class="block text-xs font-medium text-[var(--color-tron-text-secondary)]">Notes</label><textarea id="notes" bind:value={sessionNotes} rows="2" placeholder="Optional notes…" class="{inputCls} text-sm"></textarea></div>
					{#if form?.confirmComplete?.error}<p class="text-center text-sm text-[var(--color-tron-error)]">{form.confirmComplete.error}</p>{/if}
					<div class="flex justify-center gap-3 pt-2">
						<button type="submit" class="rounded-lg bg-green-600 px-6 py-3 font-bold text-white hover:bg-green-500">Confirm batch</button>
						<button type="button" onclick={() => { step = 'session'; focusScan(); }} class="rounded-lg border border-[var(--color-tron-border)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)]">Go back</button>
					</div>
				</div>
			</form>
		{/if}
	</div>

	{#if data.recentLots.length > 0 && step === 'config'}
		<div class="border-t border-[var(--color-tron-border)] pt-4">
			<h2 class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Backing lots</h2>
			<div class="mt-2 overflow-x-auto"><table class="w-full text-left text-sm">
				<thead><tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]"><th class="px-3 py-2">Lot</th><th class="px-3 py-2">Bucket</th><th class="px-3 py-2">Qty</th><th class="px-3 py-2">Operator</th><th class="px-3 py-2">Status</th><th class="px-3 py-2">Time</th></tr></thead>
				<tbody>
					{#each data.recentLots as lot (lot.lotId)}
						<tr class="border-b border-[var(--color-tron-border)]">
							<td class="px-3 py-2 font-mono text-xs"><a href="/manufacturing/cart-mfg/lots/{lot.lotId}" class="text-[var(--color-tron-cyan)] hover:underline">{lot.outputLotNumber ?? '(in progress)'}</a></td>
							<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text)]">{lot.bucketBarcode ?? '—'}</td>
							<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.quantityProduced || lot.cartridgeCount || 0}</td>
							<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.operatorName}</td>
							<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.status}</td>
							<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">{lot.finishTime ? new Date(lot.finishTime).toLocaleString() : new Date(lot.createdAt).toLocaleString()}</td>
						</tr>
					{/each}
				</tbody>
			</table></div>
		</div>
	{/if}
</div>

{#if handoffOpen}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
		<div class="max-w-sm rounded-lg border border-green-500/30 bg-[var(--color-tron-bg-secondary)] p-6 text-center shadow-lg">
			<div class="mb-3 text-4xl">&#10003;</div>
			<h3 class="text-lg font-semibold text-green-400">Batch complete</h3>
			<p class="mt-2 text-[var(--color-tron-text)]">{handoffPrompt}</p>
			<button type="button" onclick={resetAll} class="mt-4 rounded bg-[var(--color-tron-cyan)] px-6 py-2 font-semibold text-[var(--color-tron-bg-primary)]">Done</button>
		</div>
	</div>
{/if}
