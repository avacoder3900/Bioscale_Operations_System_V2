<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let showInviteForm = $state(false);

	const statusColors: Record<string, string> = {
		pending: 'border-[var(--color-tron-yellow)] text-[var(--color-tron-yellow)]',
		accepted: 'border-green-500/30 text-green-400',
		expired: 'border-[var(--color-tron-text-secondary)] text-[var(--color-tron-text-secondary)]',
		revoked: 'border-red-500/30 text-red-400'
	};

	function formatDate(d: string | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function isExpired(expiresAt: string): boolean {
		return new Date(expiresAt).getTime() < Date.now();
	}
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<p class="text-sm" style="color: var(--color-tron-text-secondary)">
			{data.invites.length} invite(s)
		</p>
		<button
			type="button"
			onclick={() => {
				showInviteForm = !showInviteForm;
			}}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
		>
			{showInviteForm ? 'Cancel' : '+ Send Invite'}
		</button>
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
		<div class="space-y-1 rounded border px-4 py-2" style="border-color: var(--color-tron-green)">
			<p class="text-sm" style="color: var(--color-tron-green)">Invite sent successfully</p>
			{#if form?.inviteUrl}
				<p class="break-all font-mono text-xs text-[var(--color-tron-text-secondary)]">
					{form.inviteUrl}
				</p>
			{/if}
		</div>
	{/if}

	<!-- Send Invite Form -->
	{#if showInviteForm}
		<div
			class="rounded border p-4"
			style="border-color: var(--color-tron-cyan); background: rgba(0,255,255,0.03)"
		>
			<form
				method="POST"
				action="?/sendInvite"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') showInviteForm = false;
						await update();
					};
				}}
				class="flex gap-3"
			>
				<input
					name="email"
					type="email"
					placeholder="Email address *"
					required
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
				/>
				<select
					name="roleId"
					class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
				>
					<option value="">No Role</option>
					{#each data.roles as role (role.id)}
						<option value={role.id}>{role.name}</option>
					{/each}
				</select>
				<button
					type="submit"
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
				>
					Send
				</button>
			</form>
		</div>
	{/if}

	<!-- Invites Table -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Email</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Role</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Status</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Invited By</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Sent</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Expires</th
					>
					<th
						class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]"
						>Actions</th
					>
				</tr>
			</thead>
			<tbody>
				{#each data.invites as inv (inv.id)}
					<tr
						class="border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]/50"
					>
						<td class="px-4 py-3 text-[var(--color-tron-text)]">{inv.email}</td>
						<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]"
							>{inv.roleName ?? '—'}</td
						>
						<td class="px-4 py-3">
							<span
								class="rounded border px-1.5 py-0.5 text-xs font-medium {statusColors[
									inv.status
								] ?? ''}"
							>
								{inv.status}
								{#if inv.status === 'pending' && isExpired(inv.expiresAt)}
									(expired)
								{/if}
							</span>
						</td>
						<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]"
							>{inv.invitedByName}</td
						>
						<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]"
							>{formatDate(inv.createdAt)}</td
						>
						<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]"
							>{formatDate(inv.expiresAt)}</td
						>
						<td class="px-4 py-3 text-right">
							{#if inv.status === 'pending' && !isExpired(inv.expiresAt)}
								<form method="POST" action="?/revokeInvite" use:enhance>
									<input type="hidden" name="inviteId" value={inv.id} />
									<button
										type="submit"
										class="min-h-[36px] text-xs text-red-400 hover:underline"
									>
										Revoke
									</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
				{#if data.invites.length === 0}
					<tr>
						<td
							colspan="7"
							class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]"
						>
							No invites sent yet
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>
</div>
