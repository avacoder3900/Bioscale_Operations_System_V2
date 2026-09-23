<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	// The action returns either a success or a fail() shape; SvelteKit infers a
	// union, so spell out one optional-field type instead of narrowing everywhere.
	type VoidResult = {
		success?: boolean;
		error?: string;
		cycleId?: string;
		cycleNumber?: number;
		restored?: { partNumber: string | null; lotId: string | null; quantity: number }[];
		removalsMarked?: number;
		thermosealCreditedCm?: number;
	};
	type RetireResult = { success?: boolean; error?: string };
	interface Props { data: PageData; form: { voidPass?: VoidResult; retire?: RetireResult } | null }
	let { data, form }: Props = $props();
	let open = $state<Record<string, boolean>>({});
	let voidingId = $state<string | null>(null);
	let voidBusy = $state(false);
	// Retire (kill the label) — admin, empty bucket only; reason required.
	let retireOpen = $state(false);
	let retireBusy = $state(false);
	const canRetire = $derived(data.canVoid && data.bucket.state !== 'retired' && data.bucket.state !== 'in_use');

	function fmt(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
	}
	const stateTint: Record<string, string> = {
		available: 'text-green-300 border-green-500/40 bg-green-900/20',
		in_use: 'text-[var(--color-tron-cyan)] border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10',
		quarantined: 'text-[var(--color-tron-yellow)] border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10',
		retired: 'text-red-300 border-red-500/40 bg-red-900/20'
	};
	const txTint: Record<string, string> = {
		create: 'text-green-300', advance: 'text-[var(--color-tron-cyan)]', consume: 'text-[var(--color-tron-cyan)]',
		scrap: 'text-red-300', adjust: 'text-[var(--color-tron-yellow)]', merge_in: 'text-green-300', merge_out: 'text-[var(--color-tron-yellow)]',
		release: 'text-[var(--color-tron-text-secondary)]', quarantine: 'text-[var(--color-tron-yellow)]', mint: 'text-[var(--color-tron-text-secondary)]', retire: 'text-red-300',
		void: 'text-[var(--color-tron-yellow)]', relabel: 'text-[var(--color-tron-text-secondary)]'
	};
</script>

<div class="space-y-5">
	<nav class="text-xs text-[var(--color-tron-text-secondary)]">
		<a href="/manufacturing/cart-mfg/buckets" class="hover:text-[var(--color-tron-cyan)]">Buckets</a>
		<span class="mx-1">/</span>
		<span class="font-mono text-[var(--color-tron-text)]">{data.bucket.bucketId}</span>
	</nav>

	<div class="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<div>
			<div class="flex items-center gap-3">
				<h1 class="font-mono text-3xl font-bold text-[var(--color-tron-cyan)]">{data.bucket.bucketId}</h1>
				<span class="rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider {stateTint[data.bucket.state] ?? ''}">{data.bucket.state}</span>
				{#if data.bucket.spotCheckPending}<span class="rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-tron-yellow)]">empty check pending</span>{/if}
			</div>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				{data.bucket.cycleCount} pass{data.bucket.cycleCount === 1 ? '' : 'es'}
				{#if data.bucket.homeLocation} · home {data.bucket.homeLocation}{/if}
				· minted {fmt(data.bucket.createdAt)}{#if data.bucket.createdBy} by {data.bucket.createdBy}{/if}
			</p>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				{#if data.bucket.barcode}Sticker <span class="font-mono text-[var(--color-tron-text)]">{data.bucket.barcode}</span>{:else}No sticker on record{/if}
				{#if data.bucket.state !== 'retired'}· <a href="/manufacturing/cart-mfg/buckets/new?bucket={encodeURIComponent(data.bucket.bucketId)}" class="text-[var(--color-tron-cyan)] hover:underline">replace sticker</a>{/if}
			</p>
			{#if data.bucket.residualNote}<p class="mt-1 text-xs text-[var(--color-tron-yellow)]">Quarantined: {data.bucket.residualNote}</p>{/if}
			{#if data.bucket.retiredAt}<p class="mt-1 text-xs text-red-300">Retired {fmt(data.bucket.retiredAt)} — {data.bucket.retiredReason}</p>{/if}
		</div>
		<div class="flex gap-2">
			{#if canRetire}
				<button type="button" onclick={() => (retireOpen = !retireOpen)} class="rounded border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/20">Retire bucket…</button>
			{:else if data.canVoid && data.bucket.state === 'in_use'}
				<span class="self-center text-[10px] text-[var(--color-tron-text-secondary)]" title="Empty or discard the open pass first">in use — cannot retire</span>
			{/if}
			<a href="/manufacturing/cart-mfg/buckets?q={encodeURIComponent(data.bucket.bucketId)}" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Open on board</a>
			<a href="/manufacturing/cart-mfg/buckets/new?bucket={encodeURIComponent(data.bucket.bucketId)}" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Replace sticker</a>
		</div>
	</div>

	{#if form?.retire?.success}
		<div class="rounded-lg border border-red-500/40 bg-red-900/15 p-3 text-xs text-red-300">
			<strong>{data.bucket.bucketId} retired.</strong> Its label is dead; the history below is kept. It no longer appears on the board except in the bucket log.
		</div>
	{:else if retireOpen && canRetire}
		<form method="POST" action="?/retire" use:enhance={() => { retireBusy = true; return async ({ update }) => { await update({ reset: false }); retireBusy = false; retireOpen = false; }; }}
			class="rounded-lg border border-red-500/40 bg-red-900/10 p-4 space-y-3">
			<p class="text-sm font-medium text-red-300">Retire {data.bucket.bucketId}?</p>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">The bucket leaves service and its sticker stops resolving. Nothing is deleted — every pass, ledger row and cartridge link stays. This cannot be undone from the UI.</p>
			<label class="block">
				<span class="text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Reason (required)</span>
				<input type="text" name="reason" required placeholder="e.g. cracked tub" class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]" />
			</label>
			{#if form?.retire?.error}<p class="text-xs text-[var(--color-tron-error)]">{form.retire.error}</p>{/if}
			<div class="flex gap-2">
				<button type="submit" disabled={retireBusy} class="rounded bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-50">{retireBusy ? 'Retiring…' : 'Retire bucket'}</button>
				<button type="button" onclick={() => (retireOpen = false)} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)]">Cancel</button>
			</div>
		</form>
	{/if}

	{#if form?.voidPass?.success}
		{@const v = form.voidPass}
		<div class="rounded-lg border border-green-500/40 bg-green-900/15 p-3 text-xs text-green-300">
			<strong>{data.bucket.bucketId} #{v.cycleNumber} voided.</strong>
			{#if (v.restored ?? []).length > 0}
				Returned to inventory: {#each v.restored ?? [] as r, i (i)}{i > 0 ? ', ' : ''}<span class="font-mono">{r.quantity}× {r.partNumber ?? 'part'}</span>{#if r.lotId} → lot <span class="font-mono">{r.lotId}</span>{/if}{/each}.
			{:else}
				No inventory debits were recorded against this pass, so nothing needed returning.
			{/if}
			{#if (v.thermosealCreditedCm ?? 0) > 0}
				{v.thermosealCreditedCm} cm of thermoseal was credited back to its roll (an opened roll is never returned to stock).
			{/if}
			{#if (v.removalsMarked ?? 0) > 0}{v.removalsMarked} scrap entr{v.removalsMarked === 1 ? 'y' : 'ies'} marked voided.{/if}
		</div>
	{/if}

	<section>
		<h2 class="mb-2 text-sm font-medium text-[var(--color-tron-text-secondary)]">Passes</h2>
		{#if data.cycles.length === 0}
			<p class="rounded border border-[var(--color-tron-border)] p-6 text-center text-xs text-[var(--color-tron-text-secondary)]">This tub has never been filled.</p>
		{:else}
			<div class="space-y-2">
				{#each data.cycles as c (c.cycleId)}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
						<button type="button" onclick={() => (open[c.cycleId] = !open[c.cycleId])} class="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left">
							<span class="font-mono text-base text-[var(--color-tron-text)]">{data.bucket.bucketId} <span class="text-[var(--color-tron-text-secondary)]">#{c.cycleNumber}</span></span>
							<span class="rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider {c.status === 'open' ? 'border-[var(--color-tron-cyan)]/40 text-[var(--color-tron-cyan)]' : c.status === 'scrapped' ? 'border-red-500/40 text-red-300' : c.status === 'voided' ? 'border-[var(--color-tron-yellow)]/50 text-[var(--color-tron-yellow)]' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">{c.status === 'open' ? c.stageLabel : c.status}</span>
							<span class="text-sm text-[var(--color-tron-text)]">{c.status === 'open' ? c.quantity : c.openedQty} <span class="text-xs text-[var(--color-tron-text-secondary)]">{c.status === 'open' ? 'carts in bucket' : 'carts when it left Raw'}</span></span>
							{#if c.cartridges.inOven > 0}<span class="text-xs text-[var(--color-tron-text-secondary)]">→ {c.cartridges.inOven} into the oven</span>{/if}
							{#if c.closedWithResidual}<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">residual found</span>{/if}
							{#if c.discrepancies.some((d: any) => d.type === 'overrun')}<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">overrun</span>{/if}
							<span class="ml-auto text-xs text-[var(--color-tron-text-secondary)]">{fmt(c.openedAt)}{c.closedAt ? ` → ${fmt(c.closedAt)}` : ''}</span>
						</button>

						{#if open[c.cycleId]}
							<div class="space-y-3 border-t border-[var(--color-tron-border)] px-4 py-3 text-xs">
								{#if c.status === 'voided'}
									<div class="rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/5 p-2 text-[var(--color-tron-yellow)]">
										Voided {fmt(c.voidedAt)}{c.voidedBy ? ` by ${c.voidedBy}` : ''} — {c.voidReason ?? ''}. Its inventory debits were returned; the record is kept.
									</div>
								{:else if data.canVoid}
									<!-- Void: for a pass that never really happened (test data, wrong lot).
									     Refused server-side if cartridges were serialized from it. -->
									{#if voidingId === c.cycleId}
										<form method="POST" action="?/voidPass"
											use:enhance={() => { voidBusy = true; return async ({ update }) => { await update({ reset: false }); voidBusy = false; voidingId = null; }; }}
											class="rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/5 p-3 space-y-2">
											<input type="hidden" name="cycleId" value={c.cycleId} />
											<p class="text-[var(--color-tron-text)]">
												Void <span class="font-mono">{data.bucket.bucketId} #{c.cycleNumber}</span>? Everything this pass took from inventory
												(shells and labels at scan-in, discards) is returned to the <em>same lots</em>, the thermoseal length goes back on its roll, and its carts are voided. The pass, its ledger and its
												scrap entries are kept and marked voided. Not possible once any of its carts went into the oven.
											</p>
											<input type="text" name="reason" required placeholder="Why? e.g. test data from preview review"
												class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
											<div class="flex gap-2">
												<button type="submit" disabled={voidBusy} class="rounded border border-[var(--color-tron-yellow)]/60 bg-[var(--color-tron-yellow)]/15 px-3 py-1.5 font-semibold text-[var(--color-tron-yellow)] disabled:opacity-40">{voidBusy ? 'Voiding…' : 'Void pass & return inventory'}</button>
												<button type="button" onclick={() => (voidingId = null)} class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-[var(--color-tron-text-secondary)]">Cancel</button>
											</div>
										</form>
									{:else}
										<div class="flex justify-end">
											<button type="button" onclick={() => (voidingId = c.cycleId)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-yellow)]/60 hover:text-[var(--color-tron-yellow)]">Void this pass…</button>
										</div>
									{/if}
									{#if form?.voidPass?.error && form.voidPass.cycleId === c.cycleId}
										<p class="text-[var(--color-tron-error)]">{form.voidPass.error}</p>
									{/if}
								{/if}
								<div class="flex flex-wrap gap-x-4 gap-y-1 text-[var(--color-tron-text-secondary)]">
									<span>opened by <span class="text-[var(--color-tron-text)]">{c.openedBy ?? '—'}</span></span>
									{#if c.emptyConfirmedBy}<span>empty confirmed by <span class="text-[var(--color-tron-text)]">{c.emptyConfirmedBy}</span></span>{/if}
									{#each c.sourceLots as l (l.partNumber + l.lotId)}<span>{l.partNumber} <span class="font-mono text-[var(--color-tron-text)]">{l.lotId}</span></span>{/each}
								</div>

								{#if c.lots.length > 0}
									<div>
										<p class="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">WI-01 batches</p>
										<ul class="space-y-0.5">
											{#each c.lots as l (l.lotId)}
												<li><a href="/manufacturing/cart-mfg/lots/{l.lotId}" class="font-mono text-[var(--color-tron-cyan)] hover:underline">{l.outputLotNumber ?? l.lotId}</a> <span class="text-[var(--color-tron-text-secondary)]">· {l.status ?? '—'}{l.quantityProduced != null ? ` · ${l.quantityProduced} produced` : ''}</span></li>
											{/each}
										</ul>
									</div>
								{/if}

								{#if c.cartridges.count > 0}
									<div>
										<p class="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Carts born in this pass ({c.cartridges.count})</p>
										<div class="flex flex-wrap gap-1">
											{#each c.cartridges.ids as id (id)}<a href="/cartridge-admin/dhr/{id}" class="rounded bg-[var(--color-tron-bg-primary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-tron-cyan)] hover:underline">{id.slice(0, 8)}…</a>{/each}
											{#if c.cartridges.count > c.cartridges.ids.length}<a href="/cartridge-admin?search={encodeURIComponent(data.bucket.bucketId)}" class="px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)] hover:underline">+{c.cartridges.count - c.cartridges.ids.length} more</a>{/if}
										</div>
									</div>
								{/if}

								{#if c.residualFound.length > 0 || c.discrepancies.length > 0}
									<div class="rounded border border-[var(--color-tron-yellow)]/30 bg-[var(--color-tron-yellow)]/5 p-2">
										{#each c.discrepancies as d, i (i)}<p class="text-[var(--color-tron-yellow)]">{d.type}: {d.qty} — {d.note ?? ''} <span class="text-[var(--color-tron-text-secondary)]">({fmt(d.at)})</span></p>{/each}
										{#each c.residualFound as r, i (i)}<p class="text-[var(--color-tron-text-secondary)]">residual {r.qty} at {r.stage} → {r.disposition} by {r.by ?? '—'} ({fmt(r.at)})</p>{/each}
									</div>
								{/if}

								<div>
									<p class="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Ledger</p>
									<table class="w-full">
										<tbody>
											{#each c.transactions as t (t.id)}
												<tr class="border-t border-[var(--color-tron-border)]/40">
													<td class="py-1 pr-2 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{fmt(t.at)}</td>
													<td class="py-1 pr-2 font-semibold uppercase {txTint[t.type] ?? ''}">{t.type}</td>
													<td class="py-1 pr-2 text-[var(--color-tron-text-secondary)]">{t.fromStage && t.toStage && t.fromStage !== t.toStage ? `${t.fromStage} → ${t.toStage}` : (t.toStage ?? '')}</td>
													<td class="py-1 pr-2 tabular-nums text-[var(--color-tron-text)]">{t.qtyBefore} → {t.qtyAfter}{t.qtyDelta ? ` (${t.qtyDelta > 0 ? '+' : ''}${t.qtyDelta})` : ''}</td>
													<td class="py-1 pr-2 text-[var(--color-tron-text-secondary)]">{t.operator ?? '—'}</td>
													<td class="py-1 text-[var(--color-tron-text-secondary)]">{t.journal ?? t.reason ?? ''}</td>
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	{#if data.removals.length > 0}
		<section>
			<h2 class="mb-2 text-sm font-medium text-[var(--color-tron-text-secondary)]">Scrap journal</h2>
			<div class="space-y-2">
				{#each data.removals as r (r.id)}
					<div class="rounded border border-red-500/30 bg-red-900/10 p-3 text-xs {r.voided ? 'opacity-60' : ''}">
						<div class="flex items-center justify-between">
							<span class="font-semibold text-red-300">{r.count} scrapped{#if r.voided} <span class="ml-1 rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">voided pass</span>{/if}</span>
							<span class="text-[var(--color-tron-text-secondary)]">{r.operator ?? '—'} · {fmt(r.at)}</span>
						</div>
						<p class="mt-1 whitespace-pre-wrap text-[var(--color-tron-text)]">{r.journal}</p>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if data.bucketTransactions.length > 0}
		<section>
			<h2 class="mb-2 text-sm font-medium text-[var(--color-tron-text-secondary)]">Bucket events</h2>
			<table class="w-full text-xs">
				<tbody>
					{#each data.bucketTransactions as t (t.id)}
						<tr class="border-t border-[var(--color-tron-border)]/40">
							<td class="py-1 pr-2 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">{fmt(t.at)}</td>
							<td class="py-1 pr-2 font-semibold uppercase {txTint[t.type] ?? ''}">{t.type}</td>
							<td class="py-1 pr-2 text-[var(--color-tron-text-secondary)]">{t.operator ?? '—'}</td>
							<td class="py-1 text-[var(--color-tron-text-secondary)]">{t.reason ?? ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</div>
