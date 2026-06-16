<script lang="ts">
	interface Assay {
		_id: string;
		name: string;
		skuCode: string;
	}
	interface OpticalConfirmation {
		assay?: { _id?: string; name?: string; skuCode?: string } | null;
	}
	interface Props {
		data: {
			opticalConfirmation: OpticalConfirmation | null;
			assays: Assay[];
		};
	}

	let { data }: Props = $props();

	let assays = $derived(data.assays ?? []);
	let selectedAssaySku = $state<string>(data.opticalConfirmation?.assay?.skuCode ?? '');
	let isSavingAssay = $state(false);
	let message = $state<{ type: 'success' | 'error'; text: string } | null>(null);

	async function saveAssay() {
		isSavingAssay = true;
		message = null;
		try {
			const chosen = (data.assays ?? []).find((a) => a.skuCode === selectedAssaySku) ?? null;
			const res = await fetch('/api/validation/optical-confirmation/criteria', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					assay: chosen ? { _id: chosen._id, name: chosen.name, skuCode: chosen.skuCode } : null
				})
			});
			const body = await res.json();
			if (res.ok && body.success) {
				message = {
					type: 'success',
					text: chosen ? `Optical-confirmation assay set to ${chosen.skuCode}.` : 'Assay cleared.'
				};
			} else {
				message = { type: 'error', text: body.error ?? `Save failed (${res.status}).` };
			}
		} catch (err) {
			message = { type: 'error', text: err instanceof Error ? err.message : 'Save failed.' };
		} finally {
			isSavingAssay = false;
		}
	}
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
	<div>
		<h1 class="tron-heading text-2xl font-bold">Optical Confirmation — Assay</h1>
		<p class="tron-text-muted mt-1">
			Set the single assay stamped onto every optical-test cartridge at capture. Pass/fail criteria
			will be configured later.
		</p>
	</div>

	{#if message}
		{#if message.type === 'success'}
			<div
				class="rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-4 text-[var(--color-tron-green)]"
			>
				{message.text}
			</div>
		{:else}
			<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
				{message.text}
			</div>
		{/if}
	{/if}

	<div class="tron-card p-6">
		<h2 class="tron-heading mb-2 text-lg font-semibold">Optical Confirmation Assay</h2>
		<p class="tron-text-muted mb-4 text-sm">
			Picked from the assay catalog. Batch capture applies this to every cartridge.
		</p>
		<div class="flex flex-wrap items-end gap-4">
			<div class="min-w-64 flex-1">
				<label for="ocAssay" class="tron-text-muted mb-2 block text-sm font-medium">Assay</label>
				<select
					id="ocAssay"
					bind:value={selectedAssaySku}
					class="tron-input w-full rounded-lg px-4 py-3"
				>
					<option value="">— None —</option>
					{#each assays as a (a._id)}
						<option value={a.skuCode}>{a.name} ({a.skuCode})</option>
					{/each}
				</select>
			</div>
			<button
				type="button"
				onclick={saveAssay}
				disabled={isSavingAssay}
				class="rounded-lg bg-[var(--color-tron-orange)] px-6 py-3 font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{isSavingAssay ? 'Saving…' : 'Set Assay'}
			</button>
		</div>
		{#if !selectedAssaySku}
			<p class="mt-2 text-xs text-[var(--color-tron-red)]">
				No assay set — batch capture is blocked until you set one.
			</p>
		{/if}
	</div>
</div>
