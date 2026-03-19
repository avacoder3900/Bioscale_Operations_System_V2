<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { data, form } = $props();

	let showCreateForm = $state(false);
	let expandedId = $state<string | null>(null);
	let searchInput = $state($page.url.searchParams.get('search') ?? '');

	function doSearch() {
		const url = new URL($page.url);
		if (searchInput.trim()) url.searchParams.set('search', searchInput.trim());
		else url.searchParams.delete('search');
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- URL built from current page
		goto(url.toString(), { replaceState: true, invalidateAll: true });
	}
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<p class="text-sm" style="color: var(--color-tron-text-secondary)">
			{data.users.length} user(s)
		</p>
		<button
			type="button"
			onclick={() => {
				showCreateForm = !showCreateForm;
			}}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
		>
			{showCreateForm ? 'Cancel' : '+ Create User'}
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

	<!-- Search -->
	<div class="flex gap-2">
		<input
			bind:value={searchInput}
			onkeydown={(e) => {
				if (e.key === 'Enter') doSearch();
			}}
			placeholder="Search by username or email..."
			class="min-h-[44px] flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
		/>
		<button
			type="button"
			onclick={doSearch}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
		>
			Search
		</button>
	</div>

	<!-- Create User Form -->
	{#if showCreateForm}
		<div
			class="rounded border p-4"
			style="border-color: var(--color-tron-cyan); background: rgba(0,255,255,0.03)"
		>
			<h3 class="mb-3 text-sm font-medium" style="color: var(--color-tron-text)">
				Create New User
			</h3>
			<form
				method="POST"
				action="?/createUser"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') showCreateForm = false;
						await update();
					};
				}}
			>
				<div class="grid grid-cols-2 gap-3">
					<input
						name="username"
						placeholder="Username *"
						required
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
					<input
						name="password"
						type="password"
						placeholder="Password *"
						required
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
					<input
						name="firstName"
						placeholder="First Name"
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
					<input
						name="lastName"
						placeholder="Last Name"
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
					<input
						name="email"
						type="email"
						placeholder="Email"
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					/>
					<select
						name="roleIds"
						class="min-h-[44px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
					>
						<option value="">No Role</option>
						{#each data.roles as role (role.id)}
							<option value={role.id}>{role.name}</option>
						{/each}
					</select>
				</div>
				<div class="mt-3 flex justify-end">
					<button
						type="submit"
						class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)]"
					>
						Create
					</button>
				</div>
			</form>
		</div>
	{/if}

	<!-- Users Table -->
	<div class="overflow-x-auto rounded border border-[var(--color-tron-border)]">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]">
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Username</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Name</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Email</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Roles</th
					>
					<th
						class="px-4 py-3 text-left font-medium text-[var(--color-tron-text-secondary)]"
						>Status</th
					>
					<th
						class="px-4 py-3 text-right font-medium text-[var(--color-tron-text-secondary)]"
						>Actions</th
					>
				</tr>
			</thead>
			<tbody>
				{#each data.users as u (u.id)}
					<tr
						class="border-b border-[var(--color-tron-border)]/50 hover:bg-[var(--color-tron-surface)]/50"
					>
						<td
							class="px-4 py-3 font-mono text-xs"
							style="color: var(--color-tron-cyan)">{u.username}</td
						>
						<td class="px-4 py-3 text-[var(--color-tron-text)]">
							{u.firstName && u.lastName
								? `${u.firstName} ${u.lastName}`
								: u.firstName || '—'}
						</td>
						<td class="px-4 py-3 text-xs text-[var(--color-tron-text-secondary)]"
							>{u.email ?? '—'}</td
						>
						<td class="px-4 py-3">
							<div class="flex flex-wrap gap-1">
								{#each u.roles as role (role.id)}
									<span
										class="rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-1.5 py-0.5 text-xs text-[var(--color-tron-cyan)]"
									>
										{role.name}
									</span>
								{/each}
								{#if u.roles.length === 0}
									<span class="text-xs text-[var(--color-tron-text-secondary)]"
										>No roles</span
									>
								{/if}
							</div>
						</td>
						<td class="px-4 py-3">
							{#if u.isActive}
								<span
									class="rounded border border-green-500/30 bg-green-900/20 px-1.5 py-0.5 text-xs text-green-400"
									>Active</span
								>
							{:else}
								<span
									class="rounded border border-red-500/30 bg-red-900/20 px-1.5 py-0.5 text-xs text-red-400"
									>Inactive</span
								>
							{/if}
						</td>
						<td class="px-4 py-3 text-right">
							<div class="flex items-center justify-end gap-2">
								{#if u.isActive}
									<form method="POST" action="?/deactivateUser" use:enhance>
										<input type="hidden" name="userId" value={u.id} />
										<button
											type="submit"
											class="min-h-[36px] text-xs text-[var(--color-tron-text-secondary)] hover:text-red-400"
											>Deactivate</button
										>
									</form>
								{:else}
									<form method="POST" action="?/reactivateUser" use:enhance>
										<input type="hidden" name="userId" value={u.id} />
										<button
											type="submit"
											class="min-h-[36px] text-xs text-[var(--color-tron-text-secondary)] hover:text-green-400"
											>Reactivate</button
										>
									</form>
								{/if}
								<button
									type="button"
									onclick={() => {
										expandedId = expandedId === u.id ? null : u.id;
									}}
									class="min-h-[36px] text-xs text-[var(--color-tron-cyan)]"
								>
									{expandedId === u.id ? 'Hide' : 'Manage'}
								</button>
							</div>
						</td>
					</tr>
					{#if expandedId === u.id}
						<tr>
							<td
								colspan="6"
								class="bg-[var(--color-tron-surface)]/30 px-4 py-4"
							>
								<div class="space-y-4">
									<!-- Assign Role -->
									<div>
										<p
											class="mb-2 text-xs font-medium text-[var(--color-tron-text-secondary)]"
										>
											Add Role
										</p>
										<form
											method="POST"
											action="?/assignRole"
											use:enhance
											class="flex gap-2"
										>
											<input
												type="hidden"
												name="userId"
												value={u.id}
											/>
											<select
												name="roleId"
												class="min-h-[36px] rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"
											>
												{#each data.roles.filter((r) => !u.roles.some((ur) => ur.id === r.id)) as role (role.id)}
													<option value={role.id}>{role.name}</option>
												{/each}
											</select>
											<button
												type="submit"
												class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
												>Assign</button
											>
										</form>
									</div>

									<!-- Remove Roles -->
									{#if u.roles.length > 0}
										<div>
											<p
												class="mb-2 text-xs font-medium text-[var(--color-tron-text-secondary)]"
											>
												Current Roles
											</p>
											<div class="flex flex-wrap gap-2">
												{#each u.roles as role (role.id)}
													<form
														method="POST"
														action="?/removeRole"
														use:enhance
														class="inline"
													>
														<input
															type="hidden"
															name="userId"
															value={u.id}
														/>
														<input
															type="hidden"
															name="roleId"
															value={role.id}
														/>
														<button
															type="submit"
															class="flex min-h-[32px] items-center gap-1 rounded border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/10 px-2 py-1 text-xs text-[var(--color-tron-cyan)]"
														>
															{role.name}
															<span class="text-red-400">x</span>
														</button>
													</form>
												{/each}
											</div>
										</div>
									{/if}

									<!-- Reset Password -->
									<div>
										<p
											class="mb-2 text-xs font-medium text-[var(--color-tron-text-secondary)]"
										>
											Reset Password
										</p>
										<form
											method="POST"
											action="?/resetPassword"
											use:enhance
											class="flex gap-2"
										>
											<input
												type="hidden"
												name="userId"
												value={u.id}
											/>
											<input
												name="newPassword"
												type="password"
												placeholder="New password"
												required
												class="min-h-[36px] w-48 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm text-[var(--color-tron-text)]"
											/>
											<button
												type="submit"
												class="min-h-[36px] rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text)]"
												>Reset</button
											>
										</form>
									</div>
								</div>
							</td>
						</tr>
					{/if}
				{/each}
				{#if data.users.length === 0}
					<tr>
						<td
							colspan="6"
							class="px-4 py-8 text-center text-sm text-[var(--color-tron-text-secondary)]"
						>
							No users found
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>
</div>
