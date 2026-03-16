<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let submitting = $state(false);
</script>

<svelte:head>
	<title>Accept Invite | Bioscale</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center" style="background: var(--color-tron-bg-primary)">
	<div class="w-full max-w-md rounded border border-[var(--color-tron-border)] p-8" style="background: var(--color-tron-bg-secondary)">
		<div class="mb-6 text-center">
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Join Bioscale</h1>
			<p class="mt-1 text-sm" style="color: var(--color-tron-text-secondary)">
				Complete your registration to get started
			</p>
		</div>

		{#if data.error}
			<div class="rounded border px-4 py-3 text-center" style="border-color: var(--color-tron-error); color: var(--color-tron-error)">
				<p class="text-sm font-medium">{data.error}</p>
				<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">
					Contact your administrator for a new invite link.
				</p>
			</div>
		{:else if data.invite}
			<!-- Invite Details -->
			<div class="mb-6 rounded border border-[var(--color-tron-cyan)]/20 bg-[var(--color-tron-cyan)]/5 px-4 py-3">
				<p class="text-sm" style="color: var(--color-tron-text-secondary)">
					You've been invited as:
				</p>
				<p class="font-mono text-sm" style="color: var(--color-tron-cyan)">{data.invite.email}</p>
				{#if data.invite.roleName}
					<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
						Role: <span style="color: var(--color-tron-text)">{data.invite.roleName}</span>
					</p>
				{/if}
			</div>

			{#if form?.error}
				<div class="mb-4 rounded border px-4 py-2 text-sm" style="border-color: var(--color-tron-error); color: var(--color-tron-error)">
					{form.error}
				</div>
			{/if}

			<!-- Registration Form -->
			<form method="POST" action="?/register" use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}}>
				<input type="hidden" name="token" value={data.invite.token} />
				<div class="space-y-4">
					<div>
						<label for="username" class="mb-1 block text-sm" style="color: var(--color-tron-text-secondary)">Username</label>
						<input
							id="username"
							name="username"
							type="text"
							required
							autocomplete="username"
							class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] px-3 py-2 text-sm"
							style="background: var(--color-tron-bg-primary); color: var(--color-tron-text)"
						/>
					</div>
					<div>
						<label for="password" class="mb-1 block text-sm" style="color: var(--color-tron-text-secondary)">Password</label>
						<input
							id="password"
							name="password"
							type="password"
							required
							minlength="6"
							autocomplete="new-password"
							class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] px-3 py-2 text-sm"
							style="background: var(--color-tron-bg-primary); color: var(--color-tron-text)"
						/>
						<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
							At least 6 characters
						</p>
					</div>
					<div>
						<label for="confirmPassword" class="mb-1 block text-sm" style="color: var(--color-tron-text-secondary)">Confirm Password</label>
						<input
							id="confirmPassword"
							name="confirmPassword"
							type="password"
							required
							minlength="6"
							autocomplete="new-password"
							class="min-h-[44px] w-full rounded border border-[var(--color-tron-border)] px-3 py-2 text-sm"
							style="background: var(--color-tron-bg-primary); color: var(--color-tron-text)"
						/>
					</div>
					<button
						type="submit"
						disabled={submitting}
						class="min-h-[44px] w-full rounded py-2 text-sm font-medium disabled:opacity-50"
						style="background: var(--color-tron-cyan); color: var(--color-tron-bg-primary)"
					>
						{submitting ? 'Creating account...' : 'Create Account'}
					</button>
				</div>
			</form>
		{/if}
	</div>
</div>
