<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let confirming = $state<null | 'activate' | 'deactivate'>(null);

	function reset() {
		confirming = null;
	}
</script>

<div class="space-y-6">
	<!-- Status banner -->
	<div
		class="rounded-lg border p-5"
		style="border-color: {data.regulated
			? 'var(--color-tron-green)'
			: 'var(--color-tron-cyan)'}; background: var(--color-tron-surface)"
	>
		<div class="flex items-center justify-between gap-4">
			<div>
				<p class="text-xs uppercase tracking-wide" style="color: var(--color-tron-text-secondary)">
					QMS Environment
				</p>
				<p
					class="text-2xl font-semibold"
					style="color: {data.regulated ? 'var(--color-tron-green)' : 'var(--color-tron-cyan)'}"
				>
					{data.regulated ? 'REGULATED' : 'CONFIGURATION'}
				</p>
				<p class="mt-1 text-sm" style="color: var(--color-tron-text-secondary)">
					{#if data.regulated}
						Full GxP controls active. Privileged actions require step-up re-authentication and are
						electronically signed.
						{#if data.activatedBy}
							Started by <strong>{data.activatedBy}</strong>
							{#if data.activatedAt}on {new Date(data.activatedAt).toLocaleString()}{/if}.
						{/if}
					{:else}
						Open setup mode. Mutations are audited and anti-lockout guards apply, but step-up
						re-auth and electronic signatures are not yet enforced.
					{/if}
				</p>
			</div>
		</div>
	</div>

	{#if form?.error}
		<div
			class="rounded border px-4 py-2 text-sm"
			style="border-color: var(--color-tron-error); color: var(--color-tron-error)"
		>
			{form.error}
		</div>
	{/if}
	{#if form?.success}
		<div
			class="rounded border px-4 py-2 text-sm"
			style="border-color: var(--color-tron-green); color: var(--color-tron-green)"
		>
			QMS environment is now <strong>{form.phase === 'regulated' ? 'REGULATED' : 'CONFIGURATION'}</strong>.
		</div>
	{/if}

	<!-- Action -->
	{#if !data.regulated}
		{#if confirming !== 'activate'}
			<button
				type="button"
				onclick={() => (confirming = 'activate')}
				class="min-h-[48px] w-full rounded-lg border border-[var(--color-tron-green)] bg-[var(--color-tron-green)]/15 px-4 py-3 text-base font-semibold text-[var(--color-tron-green)]"
			>
				▶ Start QMS Regulated Environment
			</button>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				This is a deliberate, audited, one-way go-live. Once active, user, role, and permission
				changes require your password each time and are electronically signed.
			</p>
		{:else}
			<form
				method="POST"
				action="?/activate"
				use:enhance={() => async ({ update }) => {
					await update();
					reset();
				}}
				class="space-y-3 rounded-lg border border-[var(--color-tron-green)]/60 p-4"
				style="background: var(--color-tron-surface)"
			>
				<p class="text-sm font-medium" style="color: var(--color-tron-green)">
					Confirm: start the QMS regulated environment
				</p>
				<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
					Reason
					<input
						name="reason"
						required
						placeholder="e.g. Production validation go-live"
						class="mt-1 min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
				</label>
				<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
					Your password
					<input
						name="password"
						type="password"
						required
						autocomplete="current-password"
						class="mt-1 min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
				</label>
				<div class="flex gap-2">
					<button
						type="submit"
						class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-green)] bg-[var(--color-tron-green)]/20 px-4 py-2 text-sm font-semibold text-[var(--color-tron-green)]"
					>
						Confirm & Start
					</button>
					<button
						type="button"
						onclick={reset}
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]"
					>
						Cancel
					</button>
				</div>
			</form>
		{/if}
	{:else if confirming !== 'deactivate'}
		<button
			type="button"
			onclick={() => (confirming = 'deactivate')}
			class="min-h-[48px] w-full rounded-lg border border-[var(--color-tron-error)]/70 bg-[var(--color-tron-error)]/10 px-4 py-3 text-base font-semibold text-[var(--color-tron-error)]"
		>
			■ Exit Regulated Environment (controlled)
		</button>
		<p class="text-xs" style="color: var(--color-tron-text-secondary)">
			Returns the system to configuration mode. Rare — intended for validated maintenance windows.
			Requires your password and a reason, and is audited.
		</p>
	{:else}
		<form
			method="POST"
			action="?/deactivate"
			use:enhance={() => async ({ update }) => {
				await update();
				reset();
			}}
			class="space-y-3 rounded-lg border border-[var(--color-tron-error)]/60 p-4"
			style="background: var(--color-tron-surface)"
		>
			<p class="text-sm font-medium" style="color: var(--color-tron-error)">
				Confirm: exit the regulated environment
			</p>
			<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
				Reason
				<input
					name="reason"
					required
					placeholder="e.g. Scheduled validation maintenance"
					class="mt-1 min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
				/>
			</label>
			<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
				Your password
				<input
					name="password"
					type="password"
					required
					autocomplete="current-password"
					class="mt-1 min-h-[44px] w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
				/>
			</label>
			<div class="flex gap-2">
				<button
					type="submit"
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-error)] bg-[var(--color-tron-error)]/20 px-4 py-2 text-sm font-semibold text-[var(--color-tron-error)]"
				>
					Confirm & Exit
				</button>
				<button
					type="button"
					onclick={reset}
					class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]"
				>
					Cancel
				</button>
			</div>
		</form>
	{/if}

	<!-- Transition history -->
	{#if data.transitions.length}
		<div>
			<h3 class="mb-2 text-sm font-semibold" style="color: var(--color-tron-cyan)">
				Transition history
			</h3>
			<div class="space-y-1">
				{#each data.transitions as t (t.at)}
					<div
						class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs"
						style="color: var(--color-tron-text-secondary)"
					>
						<span style="color: var(--color-tron-text)">{t.from} → {t.to}</span>
						{#if t.by}· {t.by}{/if}
						{#if t.at}· {new Date(t.at).toLocaleString()}{/if}
						{#if t.reason}<div class="mt-0.5 italic">“{t.reason}”</div>{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
