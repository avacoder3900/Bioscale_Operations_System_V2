<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';

	type Result = { success?: boolean; error?: string; bucketId?: string; barcode?: string; previous?: string | null };
	interface Props {
		data: {
			presetBucket: string | null;
			recent: { bucketId: string; barcode: string | null; state: string; cycleCount: number; createdAt: string | null; createdBy: string | null }[];
		};
		form: { create?: Result; replace?: Result } | null;
	}
	let { data, form }: Props = $props();

	let qr = $state('');
	let replaceBucket = $state('');
	let replaceQr = $state('');
	let busy = $state(false);
	let presetApplied = $state(false);

	$effect(() => {
		if (!presetApplied && data.presetBucket) {
			presetApplied = true;
			if (!replaceBucket) replaceBucket = data.presetBucket;
		}
	});

	function focusQr() { setTimeout(() => document.getElementById('qr')?.focus(), 60); }
	function goBack() {
		if (typeof history !== 'undefined' && history.length > 1) history.back();
		else goto('/manufacturing/cart-mfg/buckets');
	}

	const inputCls = 'mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2.5 font-mono text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none';
</script>

<div class="space-y-5">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">New Bucket</h1>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">Stick a QR label on the tub and scan it. That's the whole thing — one bucket per scan.</p>
		</div>
		<button type="button" onclick={goBack} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/60">← Return to previous page</button>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<!-- Create -->
		<form
			method="POST"
			action="?/create"
			use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; qr = ''; focusQr(); }; }}
			class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-4 space-y-3"
		>
			<p class="text-sm font-medium text-[var(--color-tron-text)]">Create a bucket</p>
			<label class="block">
				<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Scan the tub's QR sticker</span>
				<input id="qr" type="text" name="qr" bind:value={qr} autocomplete="off" placeholder="scan…" class="{inputCls} border-[var(--color-tron-cyan)]/60 ring-1 ring-[var(--color-tron-cyan)]/30" />
			</label>
			{#if form?.create?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.create.error}</p>{/if}
			{#if form?.create?.success}
				<p class="rounded border border-green-500/40 bg-green-900/15 p-2 text-xs text-green-300">
					Bucket created — sticker <span class="font-mono">{form.create.barcode}</span>
					<span class="text-[var(--color-tron-text-secondary)]">(internal id {form.create.bucketId})</span>. It's on the board under <strong>Available</strong>.
				</p>
			{/if}
			<button type="submit" disabled={busy || !qr.trim()} class="w-full rounded-lg bg-[var(--color-tron-cyan)] py-2.5 text-sm font-bold text-[var(--color-tron-bg-primary)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30">
				{busy ? 'Creating…' : 'Create bucket'}
			</button>
		</form>

		<!-- Replace a damaged sticker (linked from the board as #replace) -->
		<form id="replace"
			method="POST"
			action="?/replace"
			use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; replaceQr = ''; }; }}
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
		>
			<p class="text-sm font-medium text-[var(--color-tron-text)]">Replace a damaged sticker</p>
			<p class="text-[10px] text-[var(--color-tron-text-secondary)]">The bucket keeps its history; only the label changes.</p>
			<label class="block">
				<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Bucket — scan its current sticker (or type its internal id)</span>
				<input type="text" name="bucketId" bind:value={replaceBucket} autocomplete="off" placeholder="scan current sticker…" class={inputCls} />
			</label>
			<label class="block">
				<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">New QR sticker</span>
				<input type="text" name="qr" bind:value={replaceQr} autocomplete="off" placeholder="scan new sticker…" class={inputCls} />
			</label>
			{#if form?.replace?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.replace.error}</p>{/if}
			{#if form?.replace?.success}
				<p class="rounded border border-green-500/40 bg-green-900/15 p-2 text-xs text-green-300">
					{form.replace.bucketId} now wears <span class="font-mono">{form.replace.barcode}</span>{#if form.replace.previous} (was <span class="font-mono">{form.replace.previous}</span>){/if}.
				</p>
			{/if}
			<button type="submit" disabled={busy || !replaceBucket.trim() || !replaceQr.trim()} class="w-full rounded-lg border border-[var(--color-tron-border)] py-2.5 text-sm font-semibold text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)]/60 disabled:opacity-30">
				Replace sticker
			</button>
		</form>
	</div>

	{#if data.recent.length > 0}
		<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<summary class="cursor-pointer text-sm font-medium text-[var(--color-tron-text)]">Recently created ({data.recent.length})</summary>
			<table class="mt-3 w-full text-xs">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
						<th class="px-2 py-1">Sticker</th><th class="px-2 py-1">Internal id</th><th class="px-2 py-1">State</th><th class="px-2 py-1">Passes</th><th class="px-2 py-1">Created</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recent as b (b.bucketId)}
						<tr class="border-b border-[var(--color-tron-border)]/40">
							<td class="px-2 py-1 font-mono text-[var(--color-tron-text)]">{b.barcode ?? '—'}</td>
							<td class="px-2 py-1 font-mono"><a href="/manufacturing/cart-mfg/buckets/{b.bucketId}" class="text-[var(--color-tron-cyan)] hover:underline">{b.bucketId}</a></td>
							<td class="px-2 py-1 text-[var(--color-tron-text)]">{b.state}</td>
							<td class="px-2 py-1 text-[var(--color-tron-text)]">{b.cycleCount}</td>
							<td class="px-2 py-1 text-[var(--color-tron-text-secondary)]">{b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}{b.createdBy ? ` · ${b.createdBy}` : ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</details>
	{/if}
</div>
