<script lang="ts">
	import { TronCard, TronButton } from '$lib/components/ui';

	interface Props {
		meaning: string;
		userName: string;
		onSign?: (password: string) => void;
		loading?: boolean;
		error?: string;
	}

	let { meaning, userName, onSign, loading = false, error }: Props = $props();

	let password = $state('');
	let timestamp = $state(new Date().toLocaleString());

	// Update timestamp every second
	$effect(() => {
		const interval = setInterval(() => {
			timestamp = new Date().toLocaleString();
		}, 1000);
		return () => clearInterval(interval);
	});

	function handleSubmit(e: Event) {
		e.preventDefault();
		if (password && onSign) {
			onSign(password);
		}
	}
</script>

<TronCard>
	<div class="space-y-6">
		<div class="text-center">
			<div
				class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border-2 border-[var(--color-tron-cyan)] bg-[var(--color-tron-bg-tertiary)]"
			>
				<svg
					class="h-8 w-8 text-[var(--color-tron-cyan)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
					/>
				</svg>
			</div>
			<h3 class="tron-text-primary text-lg font-bold">Electronic Signature</h3>
			<p class="tron-text-muted text-sm">21 CFR Part 11 Compliant</p>
		</div>

		<div
			class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4"
		>
			<p class="tron-text-primary text-sm italic">"{meaning}"</p>
		</div>

		<div class="grid grid-cols-2 gap-4 text-sm">
			<div>
				<span class="tron-text-muted">Signing as:</span>
				<p class="tron-text-primary font-medium">{userName}</p>
			</div>
			<div>
				<span class="tron-text-muted">Timestamp:</span>
				<p class="tron-text-primary font-mono">{timestamp}</p>
			</div>
		</div>

		<form onsubmit={handleSubmit} class="space-y-4">
			<div>
				<label for="signature-password" class="tron-label">Enter Password to Sign</label>
				<input
					id="signature-password"
					type="password"
					class="tron-input"
					placeholder="Your password"
					bind:value={password}
					disabled={loading}
					required
				/>
			</div>

			{#if error}
				<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
					<p class="text-sm text-[var(--color-tron-red)]">{error}</p>
				</div>
			{/if}

			<TronButton type="submit" variant="primary" class="w-full" disabled={loading || !password}>
				{#if loading}
					Signing...
				{:else}
					Sign & Complete
				{/if}
			</TronButton>
		</form>

		<p class="tron-text-muted text-center text-xs">
			By signing, you confirm that the information above is accurate and complete.
		</p>
	</div>
</TronCard>
