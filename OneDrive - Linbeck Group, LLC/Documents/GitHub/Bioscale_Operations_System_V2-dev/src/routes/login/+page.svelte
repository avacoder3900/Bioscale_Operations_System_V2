<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronInput } from '$lib/components/ui';

	let { form } = $props();

	let loading = $state(false);
</script>

<div
	class="tron-grid-bg flex min-h-screen items-center justify-center bg-[var(--color-tron-bg-primary)] px-4"
>
	<div class="w-full max-w-md">
		<div class="mb-8 text-center">
			<h1 class="mb-2 text-3xl font-bold text-[var(--color-tron-cyan)]">Bioscale Operations</h1>
			<p class="tron-text-muted">Sign in to continue</p>
		</div>

		<TronCard>
			<form
				method="POST"
				use:enhance={() => {
					loading = true;
					return async ({ update }) => {
						loading = false;
						await update();
					};
				}}
				class="space-y-6"
			>
				<div>
					<label for="username" class="tron-label">Username</label>
					<input
						id="username"
						name="username"
						type="text"
						class="tron-input"
						placeholder="Enter username"
						required
						disabled={loading}
					/>
				</div>

				<div>
					<label for="password" class="tron-label">Password</label>
					<input
						id="password"
						name="password"
						type="password"
						class="tron-input"
						placeholder="Enter password"
						required
						disabled={loading}
					/>
				</div>

				{#if form?.error}
					<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
						<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
					</div>
				{/if}

				<TronButton type="submit" variant="primary" class="w-full" disabled={loading}>
					{#if loading}
						Signing in...
					{:else}
						Sign In
					{/if}
				</TronButton>
			</form>
		</TronCard>

		<p class="tron-text-muted mt-6 text-center text-sm">
			<a href="/" class="text-[var(--color-tron-cyan)] hover:underline">← Back to home</a>
		</p>
	</div>
</div>
