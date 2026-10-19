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

	/**
	 * Focus went somewhere the user chose on purpose: a link (navigation), a
	 * field they want to type in, or anything editable. Taking focus back from
	 * those breaks the page — on /spu/[id] the "View Diagnostics" link sits far
	 * below this box, and the old unconditional refocus scrolled the box back
	 * into view between mousedown and mouseup, so the click never landed
	 * (2026-10-19). Buttons are deliberately not in this list: on a bench the
	 * next scan should still land here after pressing one.
	 */
	function keepsFocus(el: EventTarget | null): boolean {
		const node = el as HTMLElement | null;
		if (!node || node === inputElement) return false;
		if (node.isContentEditable) return true;
		return ['A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName);
	}

	function handleBlur(e: FocusEvent) {
		// Re-focus after a short delay (for barcode scanner workflows), but only
		// when focus did not move to a link or another field, and the window
		// itself still has focus. Never scroll the page to do it.
		if (disabled || keepsFocus(e.relatedTarget)) return;
		setTimeout(() => {
			if (disabled || !inputElement || !document.hasFocus()) return;
			if (keepsFocus(document.activeElement)) return;
			inputElement.focus({ preventScroll: true });
		}, 100);
	}

	$effect(() => {
		// Auto-focus on mount (and when re-enabled) without scrolling the page.
		if (inputElement && !disabled && !keepsFocus(document.activeElement)) {
			inputElement.focus({ preventScroll: true });
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
