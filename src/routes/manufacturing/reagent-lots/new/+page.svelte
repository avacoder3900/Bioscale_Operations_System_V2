<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	interface Props { data: PageData; form: ActionData }
	let { data, form }: Props = $props();

	let selectedSlug = $state(data.preselectedSlug ?? '');
	let lotBarcode = $state(data.defaultLotBarcode);

	const selectedTemplate = $derived(
		data.templates.find((t: any) => t.slug === selectedSlug)
	);

	// parameter key → value entered by operator
	let parameterValues = $state<Record<string, any>>({});

	// material key → { source, sourceId, label } for input lot picks (only "prepared" materials that should come from a finalized lot)
	let inputLotPicks = $state<Record<string, { source: string; sourceId: string; label: string }>>({});

	$effect(() => {
		// Initialize parameter defaults when template changes
		if (selectedTemplate) {
			const next: Record<string, any> = {};
			for (const p of (selectedTemplate as any).parameters ?? []) {
				next[p.key] = p.defaultValue ?? '';
			}
			parameterValues = next;
			inputLotPicks = {};
		}
	});

	// Filter candidate lots for a given material by matching the material's
	// declared upstream template slugs (canSourceFromSlugs) against each
	// candidate lot's templateSlug. If a material doesn't declare upstream
	// slugs, no candidates show — operator can still enter a barcode manually
	// since the dropdown is optional.
	function candidatesFor(material: any) {
		const allowed: string[] = material?.canSourceFromSlugs ?? [];
		if (!allowed.length) return [];
		return data.candidateLots.filter((c: any) => allowed.includes(c.templateSlug));
	}

	const preparedMaterials = $derived(
		(selectedTemplate as any)?.materials?.filter((m: any) => m.type === 'prepared') ?? []
	);

	const stockMaterials = $derived(
		(selectedTemplate as any)?.materials?.filter((m: any) => m.type === 'stock' || m.type === 'reused') ?? []
	);

	// Per-material stock barcode + concentration override entered by operator.
	// Both optional — leaving blank means "use template defaults".
	let stockEntries = $state<Record<string, { barcode: string; concentration: string }>>({});

	function buildSubmitPayload() {
		const params = Object.entries(parameterValues).map(([key, value]) => {
			const def = (selectedTemplate as any).parameters?.find((p: any) => p.key === key);
			return { key, value: def?.type === 'number' ? Number(value) : value, unit: def?.unit };
		});
		const fromPrepared = Object.entries(inputLotPicks)
			.filter(([, v]) => v && v.sourceId)
			.map(([materialKey, v]) => ({
				materialKey,
				source: v.source,
				sourceId: v.sourceId,
				label: v.label
			}));
		const fromStock = Object.entries(stockEntries)
			.filter(([, v]) => v && (v.barcode?.trim() || v.concentration?.trim()))
			.map(([materialKey, v]) => {
				const m = (selectedTemplate as any)?.materials?.find((mm: any) => mm.key === materialKey);
				return {
					materialKey,
					source: 'manual',
					barcode: v.barcode?.trim() || undefined,
					concentration: v.concentration?.trim() ? Number(v.concentration) : undefined,
					concentrationUnit: m?.defaultConcentrationUnit
				};
			});
		return { params: JSON.stringify(params), lots: JSON.stringify([...fromPrepared, ...fromStock]) };
	}
</script>

<div class="mx-auto max-w-3xl space-y-4">
	<div>
		<a href="/manufacturing/reagent-lots" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
			← Back to all lots
		</a>
		<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Start New Reagent Lot</h1>
	</div>

	{#if form?.error}
		<div class="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
			{form.error}
		</div>
	{/if}

	<form method="POST" action="?/create" use:enhance class="space-y-4">
		<div class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4 space-y-3">
			<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">1. Protocol</h2>
			<select bind:value={selectedSlug} required
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1.5 text-sm text-[var(--color-tron-text)]">
				<option value="">— pick a protocol —</option>
				{#each data.templates as tpl}
					<option value={tpl.slug}>{tpl.name} (v{tpl.version}) · {tpl.category}</option>
				{/each}
			</select>
			<input type="hidden" name="templateId" value={(selectedTemplate as any)?._id ?? ''} />
			{#if selectedTemplate}
				<p class="text-xs text-[var(--color-tron-text-secondary)]">{(selectedTemplate as any).description}</p>
			{/if}
		</div>

		<div class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4 space-y-3">
			<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">2. Lot Barcode</h2>
			<input type="text" name="lotBarcode" bind:value={lotBarcode}
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1.5 font-mono text-sm text-[var(--color-tron-text)]" />
			<p class="text-xs text-[var(--color-tron-text-secondary)]">
				Auto-suggested — overwrite or scan an existing label. Editable later from the lot's Overview tab.
			</p>
		</div>

		{#if selectedTemplate}
			<div class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4 space-y-3">
				<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">3. Key Parameters</h2>
				<div class="grid gap-3 sm:grid-cols-2">
					{#each (selectedTemplate as any).parameters as p}
						<div>
							<label class="block text-xs text-[var(--color-tron-text-secondary)]" for={`param-${p.key}`}>
								{p.label}
								{#if p.unit}<span class="text-[var(--color-tron-text-secondary)]">({p.unit})</span>{/if}
							</label>
							<input id={`param-${p.key}`} type={p.type === 'number' ? 'number' : 'text'} step="any"
								bind:value={parameterValues[p.key]}
								class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]" />
							{#if p.helpText}<p class="mt-0.5 text-xs text-[var(--color-tron-text-secondary)]">{p.helpText}</p>{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if preparedMaterials.length}
			<div class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4 space-y-3">
				<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">4. Input Lots</h2>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Materials marked "prepared" can be linked back to a finalized lot. Pick one to keep lineage intact — or leave blank if entering by hand.
				</p>
				{#each preparedMaterials as m}
					{@const cands = candidatesFor(m)}
					<div class="grid gap-1 rounded-md bg-[var(--color-tron-surface)] p-2">
						<div class="text-xs font-semibold text-[var(--color-tron-text)]">{m.label}</div>
						{#if cands.length}
							<select
								class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-xs text-[var(--color-tron-text)]"
								onchange={(e) => {
									const val = (e.target as HTMLSelectElement).value;
									if (val) {
										const lot = data.candidateLots.find((l: any) => l._id === val);
										inputLotPicks[m.key] = { source: 'reagent_lot', sourceId: val, label: lot?.lotBarcode ?? '' };
									} else {
										delete inputLotPicks[m.key];
										inputLotPicks = { ...inputLotPicks };
									}
								}}>
								<option value="">— no upstream lot —</option>
								{#each cands as c}
									<option value={c._id}>{c.lotBarcode} ({c.templateName})</option>
								{/each}
							</select>
						{:else}
							<p class="text-[10px] text-[var(--color-tron-text-secondary)]">
								No upstream protocol declared — enter the source barcode in a step note if needed.
							</p>
						{/if}
						{#if m.notes}<p class="text-[10px] text-[var(--color-tron-text-secondary)]">{m.notes}</p>{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if selectedTemplate && stockMaterials.length}
			<details class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-4">
				<summary class="cursor-pointer text-sm font-semibold text-[var(--color-tron-text)]">
					5. Stock Materials <span class="text-xs font-normal text-[var(--color-tron-text-secondary)]">— optional barcodes &amp; concentration overrides</span>
				</summary>
				<div class="mt-3 space-y-2">
					<p class="text-xs text-[var(--color-tron-text-secondary)]">
						Scan or type the supplier-lot barcode for any stock reagent you want traced.
						Override the concentration if the CofA differs from the template default. All optional — blank uses defaults.
					</p>
					{#each stockMaterials as m}
						{@const entry = stockEntries[m.key] ?? { barcode: '', concentration: '' }}
						<div class="grid grid-cols-[1fr_auto_auto] gap-2 rounded-md bg-[var(--color-tron-surface)] p-2">
							<div class="text-xs">
								<div class="font-semibold text-[var(--color-tron-text)]">{m.label}</div>
								<div class="text-[10px] text-[var(--color-tron-text-secondary)]">
									default: {m.defaultConcentration ?? '—'} {m.defaultConcentrationUnit ?? ''}
								</div>
							</div>
							<input type="text" placeholder="scan/type barcode"
								oninput={(e) => {
									const v = (e.target as HTMLInputElement).value;
									stockEntries[m.key] = { ...(stockEntries[m.key] ?? { barcode: '', concentration: '' }), barcode: v };
								}}
								value={entry.barcode}
								class="w-44 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-xs text-[var(--color-tron-text)]" />
							<input type="number" step="any" placeholder={m.defaultConcentration ? `${m.defaultConcentration}` : 'conc'}
								oninput={(e) => {
									const v = (e.target as HTMLInputElement).value;
									stockEntries[m.key] = { ...(stockEntries[m.key] ?? { barcode: '', concentration: '' }), concentration: v };
								}}
								value={entry.concentration}
								class="w-24 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 font-mono text-xs text-[var(--color-tron-text)]" />
						</div>
					{/each}
				</div>
			</details>
		{/if}

		<input type="hidden" name="parameterValues" value={buildSubmitPayload().params} />
		<input type="hidden" name="inputLots" value={buildSubmitPayload().lots} />

		<div class="flex justify-end gap-2">
			<a href="/manufacturing/reagent-lots"
				class="rounded-md border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface)]">
				Cancel
			</a>
			<button type="submit" disabled={!selectedTemplate}
				class="rounded-md bg-[var(--color-tron-cyan)]/20 px-4 py-1.5 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/30 disabled:opacity-50">
				Start Lot
			</button>
		</div>
	</form>
</div>
