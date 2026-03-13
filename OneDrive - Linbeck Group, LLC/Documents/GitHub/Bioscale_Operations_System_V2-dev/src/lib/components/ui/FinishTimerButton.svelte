<script lang="ts">
	interface Props {
		onFinish: () => void;
		label?: string;
	}

	let { onFinish, label = 'Finish Timer' }: Props = $props();

	let showModal = $state(false);
	let password = $state('');
	let error = $state('');

	function handleSubmit() {
		if (password === 'admin123') {
			showModal = false;
			password = '';
			error = '';
			onFinish();
		} else {
			error = 'Incorrect password';
			password = '';
		}
	}

	function handleCancel() {
		showModal = false;
		password = '';
		error = '';
	}
</script>

<button
	type="button"
	onclick={() => (showModal = true)}
	class="min-h-[44px] rounded-lg border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/10 px-4 py-2 text-sm font-semibold text-[var(--color-tron-yellow)] transition-all hover:bg-[var(--color-tron-yellow)]/20"
>
	{label}
</button>

{#if showModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
		<div class="w-full max-w-sm rounded-xl border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-card)] p-6">
			<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Admin Override</h3>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				Enter admin password to skip the timer.
			</p>

			{#if error}
				<div class="mt-3 rounded border border-[var(--color-tron-red)]/50 bg-[var(--color-tron-red)]/10 px-3 py-2 text-sm text-[var(--color-tron-red)]">
					{error}
				</div>
			{/if}

			<form
				onsubmit={(e) => {
					e.preventDefault();
					handleSubmit();
				}}
				class="mt-4 space-y-4"
			>
				<input
					type="password"
					bind:value={password}
					placeholder="Password"
					class="tron-input w-full"
					autofocus
				/>
				<div class="flex gap-3">
					<button
						type="button"
						onclick={handleCancel}
						class="min-h-[44px] flex-1 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--color-tron-text)] transition-all hover:border-[var(--color-tron-cyan)]"
					>
						Cancel
					</button>
					<button
						type="submit"
						class="min-h-[44px] flex-1 rounded-lg bg-[var(--color-tron-yellow)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:opacity-85"
					>
						Confirm
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
