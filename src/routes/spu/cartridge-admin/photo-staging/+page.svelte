<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let barcodes = $state('');
	let stage = $state<'wax' | 'reagent' | 'postmortem'>('wax');
	let errorMessage = $state('');
	let successMessage = $state('');
	let submitting = $state(false);

	const stageOptions: { value: 'wax' | 'reagent' | 'postmortem'; label: string }[] = [
		{ value: 'wax', label: 'Wax photos' },
		{ value: 'reagent', label: 'Reagent photos' },
		{ value: 'postmortem', label: 'Post-mortem photos' }
	];

	// Live count of distinct, non-empty barcodes in the box.
	const barcodeCount = $derived(
		new Set(
			barcodes
				.split(/[\r\n,]+/)
				.map((b) => b.trim())
				.filter(Boolean)
		).size
	);

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}

	function handleFormResult(result: { type: string; data?: Record<string, unknown> }) {
		if (result.type === 'success' && result.data?.success) {
			const count = result.data.staged as number;
			successMessage = `Staged ${count} cartridge${count !== 1 ? 's' : ''} for photos.`;
			errorMessage = '';
			barcodes = '';
		} else if (result.type === 'failure' && result.data?.error) {
			errorMessage = result.data.error as string;
			successMessage = '';
		}
	}
</script>

<div class="space-y-6">
	<div>
		<h2 class="text-lg font-semibold text-[var(--color-tron-text)]">Photo Staging</h2>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Scan or paste cartridge barcodes (one per line) and force them into the selected photo
			session. Unknown barcodes are created automatically.
		</p>
	</div>

	{#if errorMessage}
		<div
			class="rounded border border-[var(--color-tron-error)]/50 bg-[var(--color-tron-error)]/10 px-4 py-2 text-sm text-[var(--color-tron-error)]"
		>
			{errorMessage}
		</div>
	{/if}

	{#if successMessage}
		<div
			class="rounded border border-emerald-500/50 bg-emerald-900/20 px-4 py-2 text-sm text-emerald-300"
		>
			{successMessage}
		</div>
	{/if}

	<form
		method="POST"
		action="?/stage"
		class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6"
		use:enhance={() => {
			submitting = true;
			return async ({ result, update }) => {
				handleFormResult(result as { type: string; data?: Record<string, unknown> });
				submitting = false;
				await update({ reset: false });
			};
		}}
	>
		<div class="space-y-2">
			<label for="barcodes" class="block text-sm font-medium text-[var(--color-tron-text)]">
				Cartridge barcodes
				<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">
					({barcodeCount} scanned)
				</span>
			</label>
			<textarea
				id="barcodes"
				name="barcodes"
				use:focusOnMount
				bind:value={barcodes}
				rows="12"
				placeholder="Scan barcodes here, one per line..."
				class="min-h-[200px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 py-2 font-mono text-sm text-[var(--color-tron-text)] placeholder:text-[var(--color-tron-text-secondary)]/50 focus:border-[var(--color-tron-cyan)] focus:outline-none"
			></textarea>
		</div>

		<div class="space-y-2">
			<label for="stage" class="block text-sm font-medium text-[var(--color-tron-text)]">
				Photo session
			</label>
			<select
				id="stage"
				name="stage"
				bind:value={stage}
				class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-4 py-2 text-sm text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
			>
				{#each stageOptions as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
		</div>

		<div class="flex items-center gap-3">
			<button
				type="submit"
				disabled={submitting || barcodeCount === 0}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/30 disabled:cursor-not-allowed disabled:opacity-40"
			>
				{submitting ? 'Staging...' : `Stage ${barcodeCount} Cartridge${barcodeCount !== 1 ? 's' : ''}`}
			</button>
		</div>
	</form>
</div>
