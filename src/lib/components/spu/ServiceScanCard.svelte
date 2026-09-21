<script lang="ts">
	/**
	 * The servicing board's scan element, shared (SPU tweaks 2026-09-09).
	 * Scanning a unit's barcode/UDI opens (or resumes) its service job via the
	 * board's own ?/scan action — servicing is the one manually-triggered
	 * status, and this is its one control. On success the tech lands on the
	 * servicing board filtered to that unit.
	 *
	 * Opening a NEW job requires a reason (Jacob, 2026-09-09) — the server
	 * rejects a reason-less open; resuming an existing job needs nothing.
	 */
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { TronCard } from '$lib/components/ui';
	import ScanInput from '$lib/components/assembly/ScanInput.svelte';

	let scannedCode = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let scanForm: HTMLFormElement | undefined = $state();

	/**
	 * ScanInput grabs focus back on every blur, which is right for a bench
	 * scanner and wrong for the reason field beside it. Pause it whenever
	 * focus is sitting in a real field (same pattern as the servicing board).
	 */
	let scanPaused = $state(false);

	function isTextField(el: EventTarget | Element | null): boolean {
		const node = el as HTMLElement | null;
		if (!node || node.id === 'scan-input') return false;
		return ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName);
	}

	function onFocusIn(event: FocusEvent) {
		scanPaused = isTextField(event.target);
	}

	function onFocusOut() {
		// Let focus settle before deciding — blur fires before the next focus.
		setTimeout(() => {
			scanPaused = isTextField(document.activeElement);
		}, 0);
	}

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
				// The form is deliberately not reset here, so a typed reason
				// survives a bad scan and the tech can simply scan again.
				error = (result.data?.error as string) ?? 'Scan failed';
			} else {
				error = 'Scan failed';
			}
		};
	};
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div onfocusin={onFocusIn} onfocusout={onFocusOut}>
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
				disabled={scanPaused || submitting}
			/>
			<div>
				<label for="service-scan-reason" class="tron-text-muted mb-1 block text-xs uppercase">
					What's this service for?
				</label>
				<input
					id="service-scan-reason"
					name="reason"
					type="text"
					class="tron-input w-full"
					placeholder="Required to OPEN a new job — resuming an existing one needs no note"
					style="min-height: 44px;"
				/>
			</div>
		</form>
		{#if scanPaused}
			<p class="tron-text-muted mt-2 text-xs">
				Scanner paused while you type. Click back on the scan field to resume.
			</p>
		{/if}
		{#if error}
			<p class="mt-3 text-sm text-[var(--color-tron-red)]">{error}</p>
		{/if}
	</TronCard>
</div>
