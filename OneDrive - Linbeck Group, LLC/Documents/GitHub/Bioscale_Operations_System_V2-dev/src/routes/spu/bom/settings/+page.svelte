<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let syncing = $state(false);
	let disconnecting = $state(false);
	let showDisconnectConfirm = $state(false);

	function formatDateTime(date: Date | string | null): string {
		if (!date) return 'Never';
		return new Date(date).toLocaleString();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/spu/bom"
				class="tron-text-muted mb-2 inline-flex items-center gap-1 text-sm hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M15 19l-7-7 7-7"
					/>
				</svg>
				Back to BOM
			</a>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Box.com Settings</h2>
			<p class="tron-text-muted">Manage your Box.com integration for BOM sync</p>
		</div>
	</div>

	{#if data.connectionError}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-4">
			<div class="flex items-start gap-2">
				<svg
					class="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--color-tron-red)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
					/>
				</svg>
				<div>
					<p class="font-medium text-[var(--color-tron-red)]">Connection Failed</p>
					<p class="text-sm text-[var(--color-tron-red)]">{data.connectionError}</p>
				</div>
			</div>
		</div>
	{/if}

	{#if data.justConnected}
		<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-4">
			<div class="flex items-center gap-2">
				<svg
					class="h-5 w-5 text-[var(--color-tron-green)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M5 13l4 4L19 7"
					/>
				</svg>
				<p class="text-[var(--color-tron-green)]">Successfully connected to Box.com!</p>
			</div>
		</div>
	{/if}


	<div class="grid gap-6 lg:grid-cols-2">
		<!-- Connection Status -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Connection Status</h3>

			{#if !data.isConfigured}
				<div class="rounded border border-[var(--color-tron-yellow)] bg-[rgba(255,204,0,0.1)] p-4">
					<p class="text-sm text-[var(--color-tron-yellow)]">
						Box.com credentials are not configured. Please add BOX_CLIENT_ID, BOX_CLIENT_SECRET, and
						BOX_REDIRECT_URI to your environment variables.
					</p>
				</div>
			{:else if data.isConnected}
				<div class="space-y-4">
					<div class="flex items-center gap-2">
						<div class="h-3 w-3 rounded-full bg-[var(--color-tron-green)]"></div>
						<span class="text-[var(--color-tron-green)]">Connected</span>
					</div>

					<dl class="space-y-3">
						<div class="flex justify-between">
							<dt class="tron-text-muted">Target Folder</dt>
							<dd class="font-mono text-[var(--color-tron-cyan)]">{data.targetFolder}</dd>
						</div>
						<div class="flex justify-between">
							<dt class="tron-text-muted">BOM File</dt>
							<dd class="font-mono text-[var(--color-tron-cyan)]">{data.targetFile}</dd>
						</div>
						{#if data.folderId}
							<div class="flex justify-between">
								<dt class="tron-text-muted">Folder ID</dt>
								<dd class="tron-text-muted font-mono text-xs">{data.folderId}</dd>
							</div>
						{/if}
						{#if data.fileId}
							<div class="flex justify-between">
								<dt class="tron-text-muted">File ID</dt>
								<dd class="tron-text-muted font-mono text-xs">{data.fileId}</dd>
							</div>
						{:else}
							<div
								class="rounded border border-[var(--color-tron-yellow)] bg-[rgba(255,204,0,0.1)] p-2"
							>
								<p class="text-xs text-[var(--color-tron-yellow)]">
									BOM file "{data.targetFile}" not found in Box.com folder
								</p>
							</div>
						{/if}
					</dl>

					<div class="flex gap-2 pt-4">
						<TronButton variant="danger" onclick={() => (showDisconnectConfirm = true)}>
							Disconnect
						</TronButton>
					</div>
				</div>
			{:else}
				<div class="space-y-4">
					<div class="flex items-center gap-2">
						<div class="h-3 w-3 rounded-full bg-[var(--color-tron-text-secondary)]"></div>
						<span class="tron-text-muted">Not Connected</span>
					</div>

					<p class="tron-text-muted text-sm">
						Connect to Box.com to sync your Bill of Materials from the "{data.targetFolder}" folder.
					</p>

					<a href="/api/box/auth">
						<TronButton variant="primary">
							<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
								/>
							</svg>
							Connect to Box.com
						</TronButton>
					</a>
				</div>
			{/if}
		</TronCard>

		<!-- Sync Status -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Sync Status</h3>

			<dl class="space-y-3">
				<div class="flex justify-between">
					<dt class="tron-text-muted">Last Sync</dt>
					<dd class="tron-text-primary">{formatDateTime(data.lastSyncAt)}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="tron-text-muted">Status</dt>
					<dd>
						{#if data.lastSyncStatus === 'success'}
							<TronBadge variant="success">Success</TronBadge>
						{:else if data.lastSyncStatus === 'error'}
							<TronBadge variant="error">Error</TronBadge>
						{:else if data.lastSyncStatus === 'in_progress'}
							<TronBadge variant="warning">In Progress</TronBadge>
						{:else if data.lastSyncStatus === 'connected'}
							<TronBadge variant="neutral">Ready</TronBadge>
						{:else}
							<TronBadge variant="neutral">—</TronBadge>
						{/if}
					</dd>
				</div>
				{#if data.lastSyncError}
					<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-2">
						<p class="text-xs text-[var(--color-tron-red)]">{data.lastSyncError}</p>
					</div>
				{/if}
			</dl>

			{#if data.isConnected && data.fileId}
				<div class="pt-4">
					<form
						method="POST"
						action="?/syncNow"
						use:enhance={() => {
							syncing = true;
							return async ({ update }) => {
								syncing = false;
								await update();
							};
						}}
					>
						<TronButton type="submit" variant="primary" disabled={syncing}>
							<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
								/>
							</svg>
							{syncing ? 'Syncing...' : 'Sync Now'}
						</TronButton>
					</form>
				</div>
			{/if}
		</TronCard>
	</div>

	<!-- Access Rules -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-medium">Access Rules</h3>
		<div
			class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-4"
		>
			<p class="tron-text-muted mb-4 text-sm">
				This application has strict access controls for Box.com integration:
			</p>
			<ul class="space-y-2 text-sm">
				<li class="flex items-start gap-2">
					<svg
						class="mt-0.5 h-4 w-4 text-[var(--color-tron-green)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
					<span class="tron-text-primary">Can access "{data.targetFolder}" folder</span>
				</li>
				<li class="flex items-start gap-2">
					<svg
						class="mt-0.5 h-4 w-4 text-[var(--color-tron-green)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
					<span class="tron-text-primary">Can read "{data.targetFile}" for BOM sync</span>
				</li>
				<li class="flex items-start gap-2">
					<svg
						class="mt-0.5 h-4 w-4 text-[var(--color-tron-green)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
					<span class="tron-text-primary">Can create subfolders within "{data.targetFolder}"</span>
				</li>
				<li class="flex items-start gap-2">
					<svg
						class="mt-0.5 h-4 w-4 text-[var(--color-tron-green)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
					<span class="tron-text-primary"
						>Can upload files to "{data.targetFolder}" and subfolders</span
					>
				</li>
				<li class="flex items-start gap-2">
					<svg
						class="mt-0.5 h-4 w-4 text-[var(--color-tron-red)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
					<span class="text-[var(--color-tron-red)]">Cannot access any other Box.com folders</span>
				</li>
			</ul>
		</div>
	</TronCard>

	<!-- Column Mapping Link -->
	<TronCard>
		<div class="flex items-center justify-between">
			<div>
				<h3 class="tron-text-primary text-lg font-medium">Column Mapping</h3>
				<p class="tron-text-muted text-sm">Configure how Excel columns map to BOM fields</p>
			</div>
			<a href="/spu/bom/settings/mapping">
				<TronButton variant="default">Configure Mapping</TronButton>
			</a>
		</div>
	</TronCard>
</div>

<!-- Disconnect Confirmation Modal -->
{#if showDisconnectConfirm}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div
			class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6"
		>
			<h3 class="tron-text-primary mb-4 text-lg font-bold">Disconnect from Box.com?</h3>
			<p class="tron-text-muted mb-4">
				This will disconnect the Box.com integration. Your BOM data will remain in the database, but
				you won't be able to sync updates until you reconnect.
			</p>
			<form
				method="POST"
				action="?/disconnect"
				use:enhance={() => {
					disconnecting = true;
					return async ({ update, result }) => {
						disconnecting = false;
						if (result.type === 'success') {
							showDisconnectConfirm = false;
						}
						await update();
					};
				}}
			>
				<div class="flex justify-end gap-2">
					<TronButton
						type="button"
						variant="default"
						onclick={() => (showDisconnectConfirm = false)}
					>
						Cancel
					</TronButton>
					<TronButton type="submit" variant="danger" disabled={disconnecting}>
						{disconnecting ? 'Disconnecting...' : 'Disconnect'}
					</TronButton>
				</div>
			</form>
		</div>
	</div>
{/if}
