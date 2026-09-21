<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import bwipjs from 'bwip-js/browser';

	interface Props {
		data: {
			presetBucket: string | null;
			recent: { bucketId: string; barcode: string | null; state: string; cycleCount: number; homeLocation: string | null; createdAt: string | null; createdBy: string | null }[];
			unassigned: { bucketId: string; state: string }[];
		};
		form: { labels?: { success?: boolean; mode?: 'assign' | 'print'; ids?: string[]; error?: string } } | null;
	}
	let { data, form }: Props = $props();

	// ── mint ────────────────────────────────────────────────────────────────
	let mode = $state<'assign' | 'print'>('assign');
	let count = $state(5);
	let homeLocation = $state('');
	let reprintIds = $state('');
	let submitting = $state(false);

	const printIds = $derived(form?.labels?.success && form.labels.mode === 'print' ? (form.labels.ids ?? []) : []);

	// ── assign QR stickers ──────────────────────────────────────────────────
	// The queue holds buckets waiting for a sticker: freshly minted ids land
	// here automatically (assign mode), or the operator picks any bucket. The
	// assign call goes through fetch, not a form submit, so the queue survives.
	let queue = $state<string[]>([]);
	let target = $state('');
	let presetApplied = $state(false);
	let bucketScan = $state('');
	let qrScan = $state('');
	let assignBusy = $state(false);
	let assignError = $state('');
	let done = $state<{ bucketId: string; barcode: string; previous: string | null }[]>([]);
	let lastMintKey = $state('');

	$effect(() => {
		// Deep link (?bucket=) preselects a bucket for assignment — applied once,
		// so an operator who clears it isn't fought by the effect.
		if (!presetApplied && data.presetBucket) {
			presetApplied = true;
			if (!target) { target = data.presetBucket; focusQr(); }
		}
		// Seed the queue once per mint result (keyed on the first id so a
		// re-render doesn't re-seed and a fresh mint replaces the old queue).
		if (form?.labels?.success && form.labels.mode === 'assign' && form.labels.ids?.length) {
			const key = form.labels.ids[0];
			if (key !== lastMintKey) {
				lastMintKey = key;
				queue = [...form.labels.ids];
				target = queue[0];
				done = [];
				assignError = '';
				focusQr();
			}
		}
	});

	function focusQr() {
		setTimeout(() => document.getElementById('qrScan')?.focus(), 60);
	}

	function pickBucket(id: string) {
		target = id;
		assignError = '';
		focusQr();
	}

	function applyBucketScan() {
		const raw = bucketScan.trim();
		if (!raw) return;
		target = raw; // BKT- id or the tub's current sticker; the server resolves it
		bucketScan = '';
		assignError = '';
		focusQr();
	}

	async function assignSticker() {
		const code = qrScan.trim();
		if (!code || !target || assignBusy) return;
		assignBusy = true;
		assignError = '';
		qrScan = '';
		try {
			const fd = new FormData();
			fd.set('bucketId', target);
			fd.set('barcode', code);
			const res = await fetch('?/assignQr', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			// Action responses are devalue-encoded; deserialize() is the supported decoder.
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				const inner = (result.data as any)?.assign ?? {};
				done = [{ bucketId: inner.bucketId, barcode: inner.barcode, previous: inner.previous ?? null }, ...done];
				queue = queue.filter((id) => id !== inner.bucketId && id !== target);
				target = queue[0] ?? '';
				await invalidateAll();
			} else if (result.type === 'failure') {
				assignError = (result.data as any)?.assign?.error ?? `Error ${result.status}`;
			} else if (result.type === 'error') {
				assignError = result.error?.message ?? 'Assign failed';
			}
		} catch (e) {
			assignError = e instanceof Error ? e.message : 'Assign failed';
		} finally {
			assignBusy = false;
			focusQr();
		}
	}

	// ── printed labels ──────────────────────────────────────────────────────
	function qr(node: HTMLCanvasElement, code: string) {
		const draw = (c: string) => {
			try {
				bwipjs.toCanvas(node, { bcid: 'qrcode', text: c, scale: 4, height: 18, width: 18 });
			} catch (e) {
				console.error('bwip-js failed for', c, e);
			}
		};
		draw(code);
		return { update: draw };
	}
	function printLabels() { window.print(); }

	// This page lives outside the cart-mfg sidebar layout and is reached from
	// the board, a bucket's history page, or a bookmark. Go back to wherever
	// the operator came from; with no history (direct open), land on the board.
	function goBack() {
		if (typeof history !== 'undefined' && history.length > 1) history.back();
		else goto('/manufacturing/cart-mfg/buckets');
	}

	const inputCls = 'mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1.5 text-sm';
</script>

<div class="space-y-5 p-4 print:p-0">
	<div class="print:hidden space-y-4">
		<div>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h1 class="text-xl font-semibold" style="color: var(--color-tron-cyan)">Bucket Labels</h1>
				<button type="button" onclick={goBack}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)]/60"
					style="color: var(--color-tron-text-secondary)">
					← Return to previous page
				</button>
			</div>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				A bucket's identity is its <code class="font-mono text-[11px]" style="color: var(--color-tron-cyan)">BKT-NNNNNN</code> id, permanently.
				Label the tub either by <strong>assigning a QR sticker</strong> from the printed cartridge sheets (scan it onto the bucket)
				or by <strong>printing a BKT label</strong>. Both scan to the same bucket everywhere. A scuffed sticker is replaced, not the bucket.
			</p>
		</div>

		<div class="grid gap-4 lg:grid-cols-2">
			<!-- Mint -->
			<form
				method="POST"
				action="?/mint"
				use:enhance={() => { submitting = true; return async ({ update }) => { await update({ reset: false }); submitting = false; }; }}
				class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
			>
				<p class="text-sm font-medium" style="color: var(--color-tron-text)">New buckets</p>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="block">
						<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">How many (1–50)</span>
						<input type="number" name="count" bind:value={count} min="1" max="50" required class="{inputCls} w-28 font-mono" style="color: var(--color-tron-text)" />
					</label>
					<label class="block">
						<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Home location (optional)</span>
						<input type="text" name="homeLocation" bind:value={homeLocation} placeholder="e.g. B-06 shelf 2" class={inputCls} style="color: var(--color-tron-text)" />
					</label>
				</div>
				<fieldset class="space-y-1.5">
					<legend class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Label them by</legend>
					<label class="flex items-start gap-2 rounded border p-2 text-xs {mode === 'assign' ? 'border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/5' : 'border-[var(--color-tron-border)]'}" style="color: var(--color-tron-text)">
						<input type="radio" name="mode" value="assign" bind:group={mode} class="mt-0.5" />
						<span><strong>Assigning QR stickers</strong> — after minting, scan one sticker per tub from the printed sheets. Consumes 1× PT-CT-106 per bucket.</span>
					</label>
					<label class="flex items-start gap-2 rounded border p-2 text-xs {mode === 'print' ? 'border-[var(--color-tron-cyan)]/60 bg-[var(--color-tron-cyan)]/5' : 'border-[var(--color-tron-border)]'}" style="color: var(--color-tron-text)">
						<input type="radio" name="mode" value="print" bind:group={mode} class="mt-0.5" />
						<span><strong>Printing BKT labels</strong> — render the ids below for any adhesive stock, 3 across.</span>
					</label>
				</fieldset>
				<button type="submit" disabled={submitting}
					class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
					style="color: var(--color-tron-cyan)">
					{submitting ? 'Minting…' : mode === 'assign' ? `Mint ${count} & scan stickers` : `Mint ${count} & preview labels`}
				</button>
				{#if form?.labels?.error}
					<div class="rounded border border-red-500/50 bg-red-900/20 p-2 text-xs text-red-300">{form.labels.error}</div>
				{/if}
			</form>

			<!-- Assign / replace QR -->
			<div class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-4 space-y-3">
				<div class="flex items-center justify-between">
					<p class="text-sm font-medium" style="color: var(--color-tron-text)">Assign QR sticker</p>
					{#if queue.length > 0}<span class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-cyan)">{queue.length} in queue</span>{/if}
				</div>

				<div class="rounded bg-[var(--color-tron-bg)] p-3">
					<p class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Bucket</p>
					{#if target}
						<div class="mt-1 flex items-center justify-between">
							<span class="font-mono text-lg" style="color: var(--color-tron-text)">{target}</span>
							<button type="button" onclick={() => { target = ''; }} class="text-xs hover:underline" style="color: var(--color-tron-text-secondary)">change</button>
						</div>
					{:else}
						<input type="text" bind:value={bucketScan} autocomplete="off" placeholder="scan BKT- id or the tub's current sticker"
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyBucketScan(); } }}
							class="{inputCls} font-mono" style="color: var(--color-tron-text)" />
					{/if}
				</div>

				<label class="block">
					<span class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">{target ? `Scan the sticker going on ${target}` : 'Pick a bucket first'}</span>
					<input id="qrScan" type="text" bind:value={qrScan} autocomplete="off" disabled={!target || assignBusy}
						placeholder={target ? 'scan QR sticker…' : '—'}
						onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); assignSticker(); } }}
						class="{inputCls} font-mono disabled:opacity-50 {target ? 'border-[var(--color-tron-cyan)] ring-1 ring-[var(--color-tron-cyan)]/40' : ''}" style="color: var(--color-tron-text)" />
				</label>
				{#if assignBusy}<p class="text-xs" style="color: var(--color-tron-text-secondary)">Assigning…</p>{/if}
				{#if assignError}<p class="text-xs text-red-300">{assignError}</p>{/if}

				{#if done.length > 0}
					<ul class="space-y-1 text-xs">
						{#each done as d (d.bucketId + d.barcode)}
							<li class="flex items-center justify-between rounded bg-[var(--color-tron-bg)] px-2 py-1">
								<span class="font-mono" style="color: var(--color-tron-text)">{d.bucketId}</span>
								<span class="font-mono" style="color: var(--color-tron-cyan)">{d.barcode}</span>
								{#if d.previous}<span style="color: var(--color-tron-text-secondary)">replaced {d.previous.slice(0, 8)}…</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#if queue.length > 0}
					<div>
						<p class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Queue</p>
						<div class="mt-1 flex flex-wrap gap-1">
							{#each queue as id (id)}
								<button type="button" onclick={() => pickBucket(id)} class="rounded px-2 py-0.5 font-mono text-[11px] {id === target ? 'bg-[var(--color-tron-cyan)]/20' : 'bg-[var(--color-tron-bg)]'}" style="color: var(--color-tron-text)">{id}</button>
							{/each}
						</div>
					</div>
				{:else if data.unassigned.length > 0}
					<div>
						<p class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Buckets without a sticker ({data.unassigned.length})</p>
						<div class="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
							{#each data.unassigned as b (b.bucketId)}
								<button type="button" onclick={() => pickBucket(b.bucketId)} class="rounded px-2 py-0.5 font-mono text-[11px] {b.bucketId === target ? 'bg-[var(--color-tron-cyan)]/20' : 'bg-[var(--color-tron-bg)]'}" style="color: var(--color-tron-text)">{b.bucketId}</button>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		</div>

		<!-- Reprint -->
		<form
			method="POST"
			action="?/reprint"
			use:enhance={() => { submitting = true; return async ({ update }) => { await update({ reset: false }); submitting = false; }; }}
			class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 flex flex-wrap items-end gap-3"
		>
			<label class="block min-w-[240px] flex-1">
				<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Reprint BKT labels — ids, one per line or comma-separated</span>
				<textarea name="bucketIds" bind:value={reprintIds} rows="2" placeholder="BKT-000012" class="{inputCls} font-mono" style="color: var(--color-tron-text)"></textarea>
			</label>
			<button type="submit" disabled={submitting || !reprintIds.trim()}
				class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm font-medium hover:border-[var(--color-tron-text-secondary)] disabled:opacity-50"
				style="color: var(--color-tron-text)">
				Reprint
			</button>
		</form>

		{#if printIds.length > 0}
			<div class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 p-3 flex flex-wrap items-center justify-between gap-3">
				<div class="text-sm" style="color: var(--color-tron-cyan)">
					<strong>{printIds.length} label{printIds.length === 1 ? '' : 's'} ready</strong>
					<span class="ml-2 font-mono text-xs">{printIds[0]}{printIds.length > 1 ? ` … ${printIds[printIds.length - 1]}` : ''}</span>
				</div>
				<button type="button" onclick={printLabels}
					class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90">
					Print labels
				</button>
			</div>
		{/if}

		{#if data.recent.length > 0}
			<details class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<summary class="cursor-pointer text-sm font-medium" style="color: var(--color-tron-text)">Recently minted ({data.recent.length})</summary>
				<table class="mt-3 w-full text-xs">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
							<th class="px-2 py-1 text-left">Bucket</th>
							<th class="px-2 py-1 text-left">Sticker</th>
							<th class="px-2 py-1 text-left">State</th>
							<th class="px-2 py-1 text-left">Cycles</th>
							<th class="px-2 py-1 text-left">Home</th>
							<th class="px-2 py-1 text-left">Minted</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recent as b (b.bucketId)}
							<tr class="border-b border-[var(--color-tron-border)]/40">
								<td class="px-2 py-1 font-mono"><a href="/manufacturing/cart-mfg/buckets/{b.bucketId}" style="color: var(--color-tron-cyan)">{b.bucketId}</a></td>
								<td class="px-2 py-1 font-mono" style="color: var(--color-tron-text)">{#if b.barcode}{b.barcode}{:else}<button type="button" onclick={() => pickBucket(b.bucketId)} class="hover:underline" style="color: var(--color-tron-text-secondary)">assign…</button>{/if}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text)">{b.state}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text)">{b.cycleCount}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{b.homeLocation ?? '—'}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'} · {b.createdBy ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}
	</div>

	<!-- Printed labels — on-screen preview AND the print render -->
	{#if printIds.length > 0}
		<div class="print-area grid grid-cols-3 gap-3 print:gap-0">
			{#each printIds as id (id)}
				<div class="label flex items-center gap-3 rounded border border-[var(--color-tron-border)] bg-white p-3 print:rounded-none print:border-0">
					<canvas use:qr={id} class="h-[0.75in] w-[0.75in]"></canvas>
					<div class="min-w-0">
						<div class="font-mono text-lg font-bold leading-tight text-black">{id}</div>
						<div class="text-[10px] uppercase tracking-wider text-black/60">Production bucket</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	@media print {
		@page { margin: 0.4in; }
		:global(header),
		:global(aside.mfg-sidebar),
		:global(.tron-scanlines) { display: none !important; }
		:global(html), :global(body), :global(main) { margin: 0 !important; padding: 0 !important; background: white !important; }
		:global(.tron-grid-bg) { background: white !important; }
		.label { break-inside: avoid; page-break-inside: avoid; height: 1.25in; }
	}
</style>
