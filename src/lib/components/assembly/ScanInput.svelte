<script lang="ts">
	interface Props {
		label?: string;
		placeholder?: string;
		expectedPattern?: RegExp;
		onScan?: (value: string) => void;
		disabled?: boolean;
	}

	let {
		label = 'Scan Barcode',
		placeholder = 'Scan or enter barcode...',
		expectedPattern,
		onScan,
		disabled = false
	}: Props = $props();

	let inputValue = $state('');
	let error = $state('');
	let inputElement: HTMLInputElement | undefined = $state();
	let lastScanTime = $state(0);

	function playBeep(success: boolean) {
		try {
			const audioContext = new AudioContext();
			const oscillator = audioContext.createOscillator();
			const gainNode = audioContext.createGain();

			oscillator.connect(gainNode);
			gainNode.connect(audioContext.destination);

			oscillator.frequency.value = success ? 880 : 220;
			oscillator.type = 'sine';
			gainNode.gain.value = 0.3;

			oscillator.start();
			setTimeout(
				() => {
					oscillator.stop();
					audioContext.close();
				},
				success ? 100 : 300
			);
		} catch {
			// Audio not supported
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && inputValue.trim()) {
			e.preventDefault();

			// Debounce - prevent duplicate scans within 500ms
			const now = Date.now();
			if (now - lastScanTime < 500) return;
			lastScanTime = now;

			const value = inputValue.trim();

			// Validate pattern if provided
			if (expectedPattern && !expectedPattern.test(value)) {
				error = 'Invalid barcode format';
				playBeep(false);
				return;
			}

			error = '';
			playBeep(true);
			onScan?.(value);
			inputValue = '';
		}
	}

	function handleBlur() {
		// Re-focus after a short delay (for barcode scanner workflows)
		if (!disabled) {
			setTimeout(() => inputElement?.focus(), 100);
		}
	}

	$effect(() => {
		// Auto-focus on mount
		if (inputElement && !disabled) {
			inputElement.focus();
		}
	});
</script>

<div class="relative">
	<div class="flex items-center gap-3">
		<div
			class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]"
		>
			<svg
				class="h-5 w-5 text-[var(--color-tron-cyan)]"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
				/>
			</svg>
		</div>
		<div class="flex-1">
			{#if label}
				<label for="scan-input" class="tron-label">{label}</label>
			{/if}
			<input
				bind:this={inputElement}
				id="scan-input"
				type="text"
				class="tron-input {error ? 'tron-input-error' : ''}"
				{placeholder}
				bind:value={inputValue}
				onkeydown={handleKeydown}
				onblur={handleBlur}
				{disabled}
				autocomplete="off"
			/>
		</div>
	</div>
	{#if error}
		<p class="mt-2 text-sm text-[var(--color-tron-red)]">{error}</p>
	{/if}
</div>
