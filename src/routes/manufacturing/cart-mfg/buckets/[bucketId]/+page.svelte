<script lang="ts">
	let { data } = $props();
	let open = $state<Record<string, boolean>>({});

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
		release: 'text-[var(--color-tron-text-secondary)]', quarantine: 'text-[var(--color-tron-yellow)]', mint: 'text-[var(--color-tron-text-secondary)]', retire: 'text-red-300'
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
				{#if data.bucket.barcode}QR sticker <span class="font-mono text-[var(--color-tron-text)]">{data.bucket.barcode}</span>{:else}No QR sticker — printed BKT label only{/if}
				{#if data.bucket.state !== 'retired'}· <a href="/manufacturing/print-bucket-labels?bucket={encodeURIComponent(data.bucket.bucketId)}" class="text-[var(--color-tron-cyan)] hover:underline">{data.bucket.barcode ? 'replace' : 'assign'} QR</a>{/if}
			</p>
			{#if data.bucket.residualNote}<p class="mt-1 text-xs text-[var(--color-tron-yellow)]">Quarantined: {data.bucket.residualNote}</p>{/if}
			{#if data.bucket.retiredAt}<p class="mt-1 text-xs text-red-300">Retired {fmt(data.bucket.retiredAt)} — {data.bucket.retiredReason}</p>{/if}
		</div>
		<div class="flex gap-2">
			<a href="/manufacturing/cart-mfg/buckets?q={encodeURIComponent(data.bucket.bucketId)}" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Open on board</a>
			<a href="/manufacturing/print-bucket-labels?bucket={encodeURIComponent(data.bucket.bucketId)}" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]">Label / QR</a>
		</div>
	</div>

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
							<span class="rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider {c.status === 'open' ? 'border-[var(--color-tron-cyan)]/40 text-[var(--color-tron-cyan)]' : c.status === 'scrapped' ? 'border-red-500/40 text-red-300' : 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]'}">{c.status === 'open' ? c.stageLabel : c.status}</span>
							<span class="text-sm text-[var(--color-tron-text)]">{c.status === 'open' ? c.quantity : c.openedQty} <span class="text-xs text-[var(--color-tron-text-secondary)]">{c.status === 'open' ? `in tub of ${c.openedQty}` : 'opened'}</span></span>
							{#if c.cartridges.count > 0}<span class="text-xs text-[var(--color-tron-text-secondary)]">→ {c.cartridges.count} cartridge{c.cartridges.count === 1 ? '' : 's'} serialized</span>{/if}
							{#if c.closedWithResidual}<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">residual found</span>{/if}
							{#if c.discrepancies.some((d: any) => d.type === 'overrun')}<span class="rounded bg-[var(--color-tron-yellow)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-tron-yellow)]">overrun</span>{/if}
							<span class="ml-auto text-xs text-[var(--color-tron-text-secondary)]">{fmt(c.openedAt)}{c.closedAt ? ` → ${fmt(c.closedAt)}` : ''}</span>
						</button>

						{#if open[c.cycleId]}
							<div class="space-y-3 border-t border-[var(--color-tron-border)] px-4 py-3 text-xs">
								<div class="flex flex-wrap gap-x-4 gap-y-1 text-[var(--color-tron-text-secondary)]">
									<span>opened by <span class="text-[var(--color-tron-text)]">{c.openedBy ?? '—'}</span></span>
									{#if c.emptyConfirmedBy}<span>empty confirmed by <span class="text-[var(--color-tron-text)]">{c.emptyConfirmedBy}</span></span>{/if}
									{#each c.sourceLots as l (l.partNumber + l.lotId)}<span>{l.partNumber} <span class="font-mono text-[var(--color-tron-text)]">{l.lotId}</span></span>{/each}
									{#if c.pressEquipmentName}<span>press <span class="text-[var(--color-tron-text)]">{c.pressEquipmentName}</span></span>{/if}
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
										<p class="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Cartridges ({c.cartridges.count})</p>
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
					<div class="rounded border border-red-500/30 bg-red-900/10 p-3 text-xs">
						<div class="flex items-center justify-between">
							<span class="font-semibold text-red-300">{r.count} scrapped</span>
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
