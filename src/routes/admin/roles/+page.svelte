<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data, form } = $props();

	let showCreateForm = $state(false);
	let expandedId = $state<string | null>(data.selectedRole?.id ?? null);

	function selectRole(roleId: string) {
		const url = new URL($page.url);
		if (expandedId === roleId) {
			url.searchParams.delete('roleId');
			expandedId = null;
		} else {
			url.searchParams.set('roleId', roleId);
			expandedId = roleId;
		}
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.toString(), { replaceState: true, invalidateAll: true });
	}
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<p class="text-sm" style="color: var(--color-tron-text-secondary)">
			{data.roles.length} role(s)
		</p>
		<button
			type="button"
			onclick={() => {
				showCreateForm = !showCreateForm;
			}}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
		>
			{showCreateForm ? 'Cancel' : '+ Create Role'}
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
		<div
			class="rounded border px-4 py-2 text-sm"
			style="border-color: var(--color-tron-green); color: var(--color-tron-green)"
		>
			Action completed successfully
		</div>
	{/if}

	<!-- Create Role Form -->
	{#if showCreateForm}
		<div
			class="rounded border p-4"
			style="border-color: var(--color-tron-cyan); background: rgba(0,255,255,0.03)"
		>
			<form
				method="POST"
				action="?/createRole"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') showCreateForm = false;
						await update();
					};
				}}
				class="flex gap-3"
			>
				<input
					name="name"
					placeholder="Role name *"
					required
					class="min-h-[44px] w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
				/>
				<input
					name="description"
					placeholder="Description (optional)"
					class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
				/>
				<button
					type="submit"
					class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
				>
					Create
				</button>
			</form>
		</div>
	{/if}

	<!-- Roles List -->
	<div class="space-y-2">
		{#each data.roles as role (role.id)}
			<div class="rounded border border-[var(--color-tron-border)]">
				<button
					type="button"
					onclick={() => selectRole(role.id)}
					class="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--color-tron-surface)]/50"
				>
					<div>
						<span class="font-medium text-[var(--color-tron-text)]">{role.name}</span>
						{#if role.description}
							<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]"
								>— {role.description}</span
							>
						{/if}
					</div>
					<div class="flex items-center gap-3">
						<span class="text-xs text-[var(--color-tron-text-secondary)]">
							{role.userCount} user(s)
						</span>
						<span
							class="text-xs text-[var(--color-tron-cyan)] transition-transform {expandedId ===
							role.id
								? 'rotate-180'
								: ''}"
						>
							&#x25BC;
						</span>
					</div>
				</button>

				{#if expandedId === role.id && data.selectedRole}
					<div class="border-t border-[var(--color-tron-border)] px-4 py-4">
						<!-- Permission Matrix -->
						<form method="POST" action="?/setPermissions" use:enhance>
							<input type="hidden" name="roleId" value={role.id} />
							<p
								class="mb-3 text-xs font-medium text-[var(--color-tron-text-secondary)]"
							>
								Permissions
							</p>
							<div class="overflow-x-auto">
								<table class="w-full text-xs">
									<thead>
										<tr>
											<th
												class="px-2 py-1 text-left font-medium text-[var(--color-tron-text-secondary)]"
												>Resource</th
											>
											{#each ['read', 'write', 'delete', 'admin', 'approve'] as action}
												<th
													class="px-2 py-1 text-center font-medium text-[var(--color-tron-text-secondary)]"
													>{action}</th
												>
											{/each}
										</tr>
									</thead>
									<tbody>
										{#each data.permissionGroups as group (group.resource)}
											<tr
												class="border-t border-[var(--color-tron-border)]/30"
											>
												<td
													class="px-2 py-1.5 font-mono text-[var(--color-tron-text)]"
													>{group.resource}</td
												>
												{#each ['read', 'write', 'delete', 'admin', 'approve'] as action}
													{@const perm = group.permissions.find(
														(p) => p.action === action
													)}
													<td class="px-2 py-1.5 text-center">
														{#if perm}
															<input
																type="checkbox"
																name="permissionIds"
																value={perm.id}
																checked={data.selectedRole.permissionIds.includes(
																	perm.id
																)}
																class="h-4 w-4 accent-[var(--color-tron-cyan)]"
															/>
														{:else}
															<span
																class="text-[var(--color-tron-text-secondary)]"
																>—</span
															>
														{/if}
													</td>
												{/each}
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
							<div class="mt-3 flex justify-end">
								<button
									type="submit"
									class="min-h-[36px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-xs font-medium text-[var(--color-tron-cyan)]"
								>
									Save Permissions
								</button>
							</div>
						</form>

						<!-- Delete Role -->
						{#if role.name !== 'Admin' && role.name !== 'Engineer' && role.name !== 'RnD' && role.name !== 'Operator'}
							<div class="mt-4 border-t border-[var(--color-tron-border)]/30 pt-3">
								<form method="POST" action="?/deleteRole" use:enhance>
									<input type="hidden" name="roleId" value={role.id} />
									<button
										type="submit"
										class="min-h-[36px] text-xs text-red-400 hover:underline"
										>Delete this role</button
									>
								</form>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
