<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard } from '$lib/components/ui';

	let { data, form } = $props();

	let steps = $state(structuredClone(data.version.steps));

	function addPart(stepIdx: number) {
		steps[stepIdx].partRequirements = steps[stepIdx].partRequirements ?? [];
		steps[stepIdx].partRequirements.push({ partNumber: '', quantity: 1 });
	}
	function removePart(stepIdx: number, pIdx: number) {
		steps[stepIdx].partRequirements.splice(pIdx, 1);
	}
	function addField(stepIdx: number) {
		steps[stepIdx].fieldDefinitions = steps[stepIdx].fieldDefinitions ?? [];
		const n = steps[stepIdx].fieldDefinitions.length + 1;
		steps[stepIdx].fieldDefinitions.push({
			fieldName: `step_${steps[stepIdx].stepNumber}_field_${n}`,
			fieldLabel: '',
			fieldType: 'barcode_scan',
			isRequired: true,
			barcodeFieldMapping: '',
			sortOrder: n
		});
	}
	function removeField(stepIdx: number, fIdx: number) {
		steps[stepIdx].fieldDefinitions.splice(fIdx, 1);
	}

	let payload = $derived(JSON.stringify({ steps }));
	let totalScans = $derived(
		steps.reduce((n: number, s: any) => n + (s.fieldDefinitions?.length ?? 0), 0)
	);
</script>

<div class="mx-auto max-w-5xl space-y-6 p-6">
	<header class="flex items-center justify-between">
		<div>
			<h1 class="tron-text-primary text-2xl font-bold">
				Review Work Instruction · v{data.version.version}
			</h1>
			<p class="tron-text-muted text-xs">
				{data.summary.stepCount} steps · {data.summary.distinctParts} distinct parts · {totalScans} scan fields
				{#if data.isActive}<span class="ml-2 rounded bg-[var(--color-tron-cyan)] px-2 py-0.5 text-xs text-black">Active</span>{/if}
			</p>
		</div>
		<a
			href="/spu/work-instruction"
			class="text-sm text-[var(--color-tron-cyan)] hover:underline"
		>
			← Back
		</a>
	</header>

	{#if (form as any)?.error}
		<div class="rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{(form as any).error}</p>
		</div>
	{/if}
	{#if (form as any)?.saved}
		<div class="rounded-lg border border-[var(--color-tron-cyan)] bg-[rgba(0,229,255,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-cyan)]">Saved.</p>
		</div>
	{/if}

	{#each steps as step, sIdx}
		<TronCard>
			<div class="space-y-3">
				<div class="flex items-center gap-3">
					<input
						type="number"
						bind:value={step.stepNumber}
						class="w-20 rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
					/>
					<input
						type="text"
						bind:value={step.title}
						placeholder="Step title"
						class="flex-1 rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
					/>
				</div>
				<textarea
					bind:value={step.content}
					rows="3"
					class="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-xs"
				></textarea>

				<div class="border-t border-white/10 pt-2">
					<div class="flex items-center justify-between">
						<p class="tron-text-muted text-xs uppercase tracking-wide">Parts</p>
						<button
							type="button"
							onclick={() => addPart(sIdx)}
							class="text-xs text-[var(--color-tron-cyan)] hover:underline"
						>
							+ Add part
						</button>
					</div>
					{#each step.partRequirements ?? [] as p, pIdx}
						<div class="mt-2 grid grid-cols-12 gap-2 text-sm">
							<input
								bind:value={p.partNumber}
								placeholder="PT-SPU-XXX"
								class="col-span-5 rounded border border-white/10 bg-transparent px-2 py-1 font-mono"
							/>
							<input
								type="number"
								bind:value={p.quantity}
								min="1"
								class="col-span-2 rounded border border-white/10 bg-transparent px-2 py-1"
							/>
							<input
								bind:value={p.notes}
								placeholder="notes (optional)"
								class="col-span-4 rounded border border-white/10 bg-transparent px-2 py-1 text-xs"
							/>
							<button
								type="button"
								onclick={() => removePart(sIdx, pIdx)}
								class="col-span-1 text-xs text-[var(--color-tron-red)] hover:underline"
							>
								remove
							</button>
						</div>
					{/each}
				</div>

				<div class="border-t border-white/10 pt-2">
					<div class="flex items-center justify-between">
						<p class="tron-text-muted text-xs uppercase tracking-wide">Barcode Fields</p>
						<button
							type="button"
							onclick={() => addField(sIdx)}
							class="text-xs text-[var(--color-tron-cyan)] hover:underline"
						>
							+ Add field
						</button>
					</div>
					{#each step.fieldDefinitions ?? [] as f, fIdx}
						<div class="mt-2 grid grid-cols-12 gap-2 text-sm">
							<input
								bind:value={f.fieldName}
								placeholder="field_name"
								class="col-span-3 rounded border border-white/10 bg-transparent px-2 py-1 font-mono text-xs"
							/>
							<input
								bind:value={f.fieldLabel}
								placeholder="Label"
								class="col-span-4 rounded border border-white/10 bg-transparent px-2 py-1 text-xs"
							/>
							<input
								bind:value={f.barcodeFieldMapping}
								placeholder="PT-SPU-XXX"
								class="col-span-3 rounded border border-white/10 bg-transparent px-2 py-1 font-mono text-xs"
							/>
							<label class="col-span-1 flex items-center gap-1 text-xs">
								<input type="checkbox" bind:checked={f.isRequired} />
								req
							</label>
							<button
								type="button"
								onclick={() => removeField(sIdx, fIdx)}
								class="col-span-1 text-xs text-[var(--color-tron-red)] hover:underline"
							>
								remove
							</button>
						</div>
					{/each}
				</div>
			</div>
		</TronCard>
	{/each}

	<div class="flex flex-wrap items-center gap-3">
		<form method="POST" action="?/save" use:enhance>
			<input type="hidden" name="wiId" value={data.wiId} />
			<input type="hidden" name="payload" value={payload} />
			<button
				type="submit"
				class="rounded-lg border border-[var(--color-tron-cyan)] px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[rgba(0,229,255,0.1)]"
			>
				Save Draft
			</button>
		</form>

		<form method="POST" action="?/induct" use:enhance>
			<input type="hidden" name="wiId" value={data.wiId} />
			<button
				type="submit"
				class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90"
			>
				Induct (Activate)
			</button>
		</form>

		<form method="POST" action="?/reject" use:enhance>
			<input type="hidden" name="wiId" value={data.wiId} />
			<button
				type="submit"
				class="rounded-lg border border-[var(--color-tron-red)] px-4 py-2 text-sm text-[var(--color-tron-red)] hover:bg-[rgba(255,51,102,0.1)]"
			>
				Reject
			</button>
		</form>
	</div>
</div>
