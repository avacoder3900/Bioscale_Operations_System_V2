<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';

	type Result = { success?: boolean; error?: string; code?: string | null; bucketId?: string; barcode?: string; nickname?: string | null; previous?: string | null; operator?: string };
	interface Props {
		data: {
			presetBucket: string | null;
			recent: { bucketId: string; barcode: string | null; nickname: string | null; state: string; cycleCount: number; createdAt: string | null; createdBy: string | null }[];
		};
		form: { create?: Result; replace?: Result; nickname?: Result } | null;
	}
	let { data, form }: Props = $props();

	let qr = $state('');
	let replaceBucket = $state('');
	let replaceQr = $state('');
	// Third block: scan a bucket, name it.
	let nickBucket = $state('');
	let nickname = $state('');
	let busy = $state(false);
	let presetApplied = $state(false);

	$effect(() => {
		if (!presetApplied && data.presetBucket) {
			presetApplied = true;
			if (!replaceBucket) replaceBucket = data.presetBucket;
		}
	});

	function focusQr() { setTimeout(() => document.getElementById('qr')?.focus(), 60); }
	// After a create the sticker clears (each tub gets its own) and the box is
	// ready for the next scan. No badge here (user, 2026-09-30): minting is not a
	// gated step — the badge is asked for on the board at scan-in, discards and
	// move to oven.
	function afterCreate() {
		qr = '';
		focusQr();
	}
	// A gun sends Enter after the bucket's QR: jump to the name field instead of submitting.
	function nickBucketKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') { e.preventDefault(); setTimeout(() => document.getElementById('nickname')?.focus(), 60); }
	}
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

	<div class="grid gap-4 lg:grid-cols-3">
		<!-- Create -->
		<form
			method="POST"
			action="?/create"
			use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; afterCreate(); }; }}
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
					<span class="text-[var(--color-tron-text-secondary)]">(internal id {form.create.bucketId})</span>{#if form.create.operator}, minted by <strong>{form.create.operator}</strong>{/if}. It's on the board under <strong>Available</strong>.
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

		<!-- Nickname a bucket (2026-09-30): its own block, same shape as the other two.
		     Scan the tub, type a name. An empty name clears the nickname. -->
		<form id="nickname"
			method="POST"
			action="?/nickname"
			use:enhance={() => { busy = true; return async ({ update, result }) => { await update({ reset: false }); busy = false; if (result.type === 'success') { nickBucket = ''; nickname = ''; setTimeout(() => document.getElementById('nickBucket')?.focus(), 60); } }; }}
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
		>
			<p class="text-sm font-medium text-[var(--color-tron-text)]">Nickname a bucket</p>
			<p class="text-[10px] text-[var(--color-tron-text-secondary)]">A name for the floor, shown on the board next to the sticker. Leave the name empty to clear it.</p>
			<label class="block">
				<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Bucket — scan its sticker (or type its internal id)</span>
				<input id="nickBucket" type="text" name="bucketId" bind:value={nickBucket} onkeydown={nickBucketKeydown} autocomplete="off" placeholder="scan sticker…" class={inputCls} />
			</label>
			<label class="block">
				<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Nickname <span class="normal-case tracking-normal">(e.g. “Big Blue”)</span></span>
				<input id="nickname" type="text" name="nickname" bind:value={nickname} maxlength="30" autocomplete="off" placeholder="a name for the floor…" class="{inputCls} font-sans" />
			</label>
			{#if form?.nickname?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.nickname.error}</p>{/if}
			{#if form?.nickname?.success}
				<p class="rounded border border-green-500/40 bg-green-900/15 p-2 text-xs text-green-300">
					{#if form.nickname.nickname}{form.nickname.bucketId} is now <strong>{form.nickname.nickname}</strong>{#if form.nickname.previous} (was {form.nickname.previous}){/if}.{:else}Nickname cleared from {form.nickname.bucketId}{#if form.nickname.previous} (was {form.nickname.previous}){/if}.{/if}
				</p>
			{/if}
			<button type="submit" disabled={busy || !nickBucket.trim()} class="w-full rounded-lg border border-[var(--color-tron-border)] py-2.5 text-sm font-semibold text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)]/60 disabled:opacity-30">
				{nickname.trim() ? 'Set nickname' : 'Clear nickname'}
			</button>
		</form>
	</div>

	{#if data.recent.length > 0}
		<details class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<summary class="cursor-pointer text-sm font-medium text-[var(--color-tron-text)]">Recently created ({data.recent.length})</summary>
			<table class="mt-3 w-full text-xs">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
						<th class="px-2 py-1">Sticker</th><th class="px-2 py-1">Nickname</th><th class="px-2 py-1">Internal id</th><th class="px-2 py-1">State</th><th class="px-2 py-1">Passes</th><th class="px-2 py-1">Created</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recent as b (b.bucketId)}
						<tr class="border-b border-[var(--color-tron-border)]/40">
							<td class="px-2 py-1 font-mono text-[var(--color-tron-text)]">{b.barcode ?? '—'}</td>
							<td class="px-2 py-1 text-[var(--color-tron-text)]">{b.nickname ?? '—'}</td>
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
