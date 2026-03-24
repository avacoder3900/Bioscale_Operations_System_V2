<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard } from '$lib/components/ui';
	import ScanInput from '$lib/components/assembly/ScanInput.svelte';

	let { form } = $props();

	let formElement: HTMLFormElement | undefined = $state();

	function handleScan(udi: string) {
		if (formElement) {
			const input = formElement.querySelector('input[name="udi"]') as HTMLInputElement;
			if (input) {
				input.value = udi;
				formElement.requestSubmit();
			}
		}
	}
</script>

<div class="mx-auto max-w-2xl space-y-8">
	<div class="text-center">
		<h2 class="tron-text-primary mb-2 text-2xl font-bold">Start Assembly</h2>
		<p class="tron-text-muted">Scan an SPU barcode to begin or resume assembly</p>
	</div>

	<TronCard>
		<form
			bind:this={formElement}
			method="POST"
			action="?/start"
			use:enhance
			class="space-y-6"
		>
			<input type="hidden" name="udi" />

			<ScanInput label="Scan SPU Barcode" placeholder="Scan or enter UDI..." onScan={handleScan} />

			{#if form?.error}
				<div class="rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-4">
					<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
				</div>
			{/if}
		</form>
	</TronCard>

	<TronCard>
		<div class="flex items-start gap-4">
			<div
				class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-tron-bg-tertiary)]"
			>
				<svg
					class="h-6 w-6 text-[var(--color-tron-cyan)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
			</div>
			<div>
				<h3 class="tron-text-primary mb-2 font-medium">Assembly Instructions</h3>
				<ol class="tron-text-muted list-inside list-decimal space-y-2 text-sm">
					<li>Scan the SPU barcode label to begin</li>
					<li>Follow the prompts to scan each component</li>
					<li>Review the assembly summary</li>
					<li>Sign off with your credentials to complete</li>
				</ol>
			</div>
		</div>
	</TronCard>
</div>
