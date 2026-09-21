<script lang="ts">
	import { enhance } from '$app/forms';
	import bwipjs from 'bwip-js/browser';

	interface Props {
		data: {
			recent: { bucketId: string; state: string; cycleCount: number; homeLocation: string | null; createdAt: string | null; createdBy: string | null }[];
		};
		form: { labels?: { success?: boolean; mode?: 'mint' | 'reprint'; ids?: string[]; error?: string } } | null;
	}
	let { data, form }: Props = $props();

	let count = $state(5);
	let homeLocation = $state('');
	let reprintIds = $state('');
	let submitting = $state(false);

	const ids = $derived(form?.labels?.success ? (form.labels.ids ?? []) : []);
	const mode = $derived(form?.labels?.mode ?? null);

	// Renders a QR into the canvas whenever the code changes. bwip-js draws
	// synchronously into a canvas; one canvas per label is fine at these
	// counts (≤ 50) — the 80-per-page image cap only bites on Avery sheets.
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

	function printLabels() {
		window.print();
	}
</script>

<div class="space-y-5 p-4 print:p-0">
	<div class="print:hidden space-y-4">
		<div>
			<h1 class="text-xl font-semibold" style="color: var(--color-tron-cyan)">Print Bucket Labels</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				<code class="font-mono text-[11px]" style="color: var(--color-tron-cyan)">BKT-NNNNNN</code>
				is a permanent container id. Mint for new tubs; reprint the same number for a scuffed label. Labels print
				at 3 across on plain stock — any adhesive label large enough for a 0.75&quot; QR works.
			</p>
		</div>

		<div class="grid gap-4 md:grid-cols-2">
			<form
				method="POST"
				action="?/mint"
				use:enhance={() => { submitting = true; return async ({ update }) => { await update(); submitting = false; }; }}
				class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
			>
				<p class="text-sm font-medium" style="color: var(--color-tron-text)">Mint new buckets</p>
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">How many (1–50)</span>
					<input type="number" name="count" bind:value={count} min="1" max="50" required
						class="mt-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)" />
				</label>
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Home location (optional)</span>
					<input type="text" name="homeLocation" bind:value={homeLocation} placeholder="e.g. B-06 shelf 2"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm" style="color: var(--color-tron-text)" />
				</label>
				<button type="submit" disabled={submitting}
					class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
					style="color: var(--color-tron-cyan)">
					{submitting ? 'Minting…' : `Mint ${count} & preview`}
				</button>
			</form>

			<form
				method="POST"
				action="?/reprint"
				use:enhance={() => { submitting = true; return async ({ update }) => { await update(); submitting = false; }; }}
				class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3"
			>
				<p class="text-sm font-medium" style="color: var(--color-tron-text)">Reprint existing labels</p>
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Bucket ids (scan or type, one per line)</span>
					<textarea name="bucketIds" bind:value={reprintIds} rows="3" placeholder="BKT-000012"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-sm" style="color: var(--color-tron-text)"></textarea>
				</label>
				<button type="submit" disabled={submitting || !reprintIds.trim()}
					class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm font-medium hover:border-[var(--color-tron-text-secondary)] disabled:opacity-50"
					style="color: var(--color-tron-text)">
					Reprint
				</button>
			</form>
		</div>

		{#if form?.labels?.error}
			<div class="rounded border border-red-500/50 bg-red-900/20 p-3 text-sm text-red-300">{form.labels.error}</div>
		{/if}

		{#if ids.length > 0}
			<div class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 p-3 flex flex-wrap items-center justify-between gap-3">
				<div class="text-sm" style="color: var(--color-tron-cyan)">
					<strong>{mode === 'mint' ? 'Minted' : 'Reprinting'} {ids.length} label{ids.length === 1 ? '' : 's'}</strong>
					<span class="ml-2 font-mono text-xs">{ids[0]}{ids.length > 1 ? ` … ${ids[ids.length - 1]}` : ''}</span>
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

	<!-- Labels — on-screen preview AND the print render -->
	{#if ids.length > 0}
		<div class="print-area grid grid-cols-3 gap-3 print:gap-0">
			{#each ids as id (id)}
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
