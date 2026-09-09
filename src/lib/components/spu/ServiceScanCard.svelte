<script lang="ts">
	/**
	 * The servicing board's scan element, shared (SPU tweaks 2026-09-09).
	 * Scanning a unit's barcode/UDI opens (or resumes) its service job via the
	 * board's own ?/scan action — servicing is the one manually-triggered
	 * status, and this is its one control. On success the tech lands on the
	 * servicing board filtered to that unit.
	 */
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { TronCard } from '$lib/components/ui';
	import ScanInput from '$lib/components/assembly/ScanInput.svelte';

	let scannedCode = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let scanForm: HTMLFormElement | undefined = $state();

	function handleScan(value: string) {
		scannedCode = value;
		error = null;
		queueMicrotask(() => scanForm?.requestSubmit());
	}

	const submitHandler = () => {
		submitting = true;
		return async ({ result }: { result: { type: string; data?: Record<string, unknown> } }) => {
			submitting = false;
			if (result.type === 'success') {
				await goto(`/spu/mfg/servicing?q=${encodeURIComponent(scannedCode)}`);
			} else if (result.type === 'failure') {
				error = (result.data?.error as string) ?? 'Scan failed';
			} else {
				error = 'Scan failed';
			}
		};
	};
</script>

<TronCard class="border-[var(--color-tron-cyan)]">
	<h3 class="tron-text-primary mb-3 text-lg font-medium">Mark for servicing</h3>
	<form
		method="POST"
		action="/spu/mfg/servicing?/scan"
		bind:this={scanForm}
		use:enhance={submitHandler}
		class="space-y-3"
	>
		<input type="hidden" name="code" value={scannedCode} />
		<ScanInput
			label="Scan SPU barcode or UDI"
			placeholder="Scan to open or resume a service job..."
			onScan={handleScan}
			disabled={submitting}
		/>
	</form>
	{#if error}
		<p class="mt-3 text-sm text-[var(--color-tron-red)]">{error}</p>
	{/if}
</TronCard>
