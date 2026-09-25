<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';

	type MoveResult = {
		success?: boolean; error?: string;
		bucketId?: string; cycleNumber?: number; fromLabel?: string; toLabel?: string; members?: number; closed?: boolean;
	};
	interface Props {
		data: {
			canOverride: boolean;
			presetBucket: string | null;
			targets: { key: string; label: string }[];
			stageLabels: Record<string, string>;
			openPasses: { cycleId: string; bucketId: string; barcode: string | null; cycleNumber: number; stage: string; quantity: number; stageEnteredAt: string | null }[];
		};
		form: { move?: MoveResult } | null;
	}
	let { data, form }: Props = $props();

	let bucket = $state('');
	let target = $state('');
	let reason = $state('');
	let busy = $state(false);
	let bucketEl = $state<HTMLInputElement | null>(null);

	onMount(() => { if (data.presetBucket) bucket = data.presetBucket; bucketEl?.focus(); });

	// What the scanned code resolves to on the board (sticker or BKT id), for a live preview.
	const match = $derived.by(() => {
		const q = bucket.trim().toLowerCase();
		if (!q) return null;
		return data.openPasses.find(p => p.bucketId.toLowerCase() === q || (p.barcode ?? '').toLowerCase() === q) ?? null;
	});
	const ready = $derived(!!bucket.trim() && !!target && !!reason.trim() && data.canOverride);

	const inputCls = 'mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none';
	const tint: Record<string, string> = {
		barcoded: 'border-slate-500/40 text-slate-300', unpressed: 'border-sky-500/40 text-sky-300', pressed: 'border-amber-500/40 text-amber-300', in_oven: 'border-purple-500/40 text-purple-300'
	};
</script>

<svelte:head><title>Master Override — Buckets</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-4">
	<nav class="text-xs text-[var(--color-tron-text-secondary)]">
		<a href="/manufacturing/cart-mfg/buckets" class="hover:text-[var(--color-tron-cyan)]">Buckets</a>
		<span class="mx-1">/</span>
		<span class="text-[var(--color-tron-text)]">Master override</span>
	</nav>

	<div>
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Master Override</h1>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">Scan a bucket, pick a phase, and it goes there. Its carts follow.</p>
	</div>

	<div class="rounded-lg border border-red-500/50 bg-red-900/15 px-4 py-2.5 text-sm text-red-200" role="note">
		<strong>Bypasses the normal flow.</strong> No thermoseal is consumed, no "any carts discarded?" is asked, the phase order is not enforced (a bucket can go backwards), and <em>In Oven</em> skips the WI-01 session and its lot. Nothing is debited or credited. Every move is written to the bucket ledger, each cart's notes and the audit log as <span class="font-mono">MASTER OVERRIDE</span>. Admin only.
	</div>

	{#if !data.canOverride}
		<p class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-xs text-[var(--color-tron-text-secondary)]">You can view this page, but moving a bucket requires <span class="font-mono">manufacturing:admin</span>.</p>
	{/if}

	{#if form?.move?.success}
		{@const m = form.move}
		<div class="rounded-lg border border-green-500/40 bg-green-900/15 p-3 text-sm text-green-300">
			<strong>{m.bucketId} #{m.cycleNumber}</strong> moved {m.fromLabel} → <strong>{m.toLabel}</strong> with {m.members} cart{m.members === 1 ? '' : 's'}.
			{#if m.closed}The pass is closed and the bucket is back under Available (empty-check armed).{/if}
			<a href="/manufacturing/cart-mfg/buckets/{encodeURIComponent(m.bucketId ?? '')}" class="ml-1 underline">History</a>
		</div>
	{/if}

	<form
		method="POST"
		action="?/move"
		use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; bucket = ''; reason = ''; bucketEl?.focus(); }; }}
		class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		<label class="block">
			<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Bucket — scan its sticker (or type its BKT id)</span>
			<input type="text" name="bucket" bind:value={bucket} bind:this={bucketEl} autocomplete="off" placeholder="scan bucket…" class={inputCls} />
			{#if bucket.trim()}
				{#if match}
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						<span class="font-mono text-[var(--color-tron-text)]">{match.bucketId} #{match.cycleNumber}</span> — currently <span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider {tint[match.stage] ?? ''}">{data.stageLabels[match.stage] ?? match.stage}</span> with {match.quantity} cart{match.quantity === 1 ? '' : 's'}.
					</p>
				{:else}
					<p class="mt-1 text-xs text-[var(--color-tron-yellow)]">Not an open pass on the board — the move will be refused unless the bucket has an open pass.</p>
				{/if}
			{/if}
		</label>

		<div>
			<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Move to phase</span>
			<div class="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
				{#each data.targets as t (t.key)}
					<label class="flex cursor-pointer items-center justify-center gap-2 rounded border px-3 py-2 text-sm {target === t.key ? 'bg-[var(--color-tron-bg-tertiary)] ring-1 ring-[var(--color-tron-cyan)] ' : ''}{tint[t.key] ?? 'border-[var(--color-tron-border)]'} {match && match.stage === t.key ? 'opacity-50' : ''}">
						<input type="radio" name="target" value={t.key} bind:group={target} class="accent-[var(--color-tron-cyan)]" disabled={!!match && match.stage === t.key} />
						{t.label}{#if match && match.stage === t.key}<span class="text-[10px] text-[var(--color-tron-text-secondary)]">(current)</span>{/if}
					</label>
				{/each}
			</div>
			{#if target === 'in_oven'}<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">All carts become In Oven (status backing) with no WI-01 lot; the pass closes.</p>{/if}
		</div>

		<label class="block">
			<span class="text-[10px] uppercase tracking-wider text-red-300">Reason (required)</span>
			<input type="text" name="reason" bind:value={reason} required placeholder="e.g. press skipped for rework batch; bucket was mis-advanced" class={inputCls} />
		</label>

		{#if form?.move?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.move.error}</p>{/if}
		<div class="flex flex-wrap items-center gap-2">
			<button type="submit" disabled={busy || !ready} class="rounded bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50">
				{busy ? 'Moving…' : target ? `Force → ${data.targets.find(t => t.key === target)?.label ?? target}` : 'Force move'}
			</button>
			<a href="/manufacturing/cart-mfg/buckets" class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">← Return to the board</a>
		</div>
	</form>

	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
		<p class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Open passes right now</p>
		{#if data.openPasses.length === 0}
			<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">None — every bucket is empty.</p>
		{:else}
			<table class="mt-2 w-full text-xs">
				<thead class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">
					<tr><th class="py-1 text-left">Bucket</th><th class="py-1 text-left">Sticker</th><th class="py-1 text-left">Phase</th><th class="py-1 text-right">Carts</th><th class="py-1"></th></tr>
				</thead>
				<tbody>
					{#each data.openPasses as p (p.cycleId)}
						<tr class="border-t border-[var(--color-tron-border)]/40">
							<td class="py-1 font-mono text-[var(--color-tron-text)]">{p.bucketId} #{p.cycleNumber}</td>
							<td class="py-1 font-mono text-[var(--color-tron-text-secondary)]">{p.barcode ? `${p.barcode.slice(0, 8)}…` : '—'}</td>
							<td class="py-1"><span class="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider {tint[p.stage] ?? ''}">{data.stageLabels[p.stage] ?? p.stage}</span></td>
							<td class="py-1 text-right text-[var(--color-tron-text)]">{p.quantity}</td>
							<td class="py-1 text-right"><button type="button" class="text-[10px] text-[var(--color-tron-cyan)] hover:underline" onclick={() => { bucket = p.bucketId; bucketEl?.focus(); }}>use</button></td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
