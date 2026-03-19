<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let saving = $state(false);
	let testing = $state(false);
	let syncing = $state(false);
	let disconnecting = $state(false);
	let linking = $state(false);

	function formatDate(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}
</script>

<div class="space-y-6">
	<div>
		<h2 class="tron-text-primary font-mono text-2xl font-bold">Particle Cloud Settings</h2>
		<p class="tron-text-muted">Manage Particle IoT Cloud integration</p>
	</div>

	<!-- Connection Status -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-medium">Connection Status</h3>
		<dl class="space-y-3">
			<div class="flex justify-between">
				<dt class="tron-text-muted">Status</dt>
				<dd>
					{#if data.hasToken && data.isActive}
						<TronBadge variant="success">Connected</TronBadge>
					{:else if data.hasToken}
						<TronBadge variant="warning">Inactive</TronBadge>
					{:else}
						<TronBadge variant="neutral">Not Connected</TronBadge>
					{/if}
				</dd>
			</div>
			{#if data.organizationSlug}
				<div class="flex justify-between">
					<dt class="tron-text-muted">Organization</dt>
					<dd class="tron-text-primary font-mono">{data.organizationSlug}</dd>
				</div>
			{/if}
			<div class="flex justify-between">
				<dt class="tron-text-muted">Last Sync</dt>
				<dd class="tron-text-primary">{formatDate(data.lastSyncAt)}</dd>
			</div>
			{#if data.lastSyncStatus}
				<div class="flex justify-between">
					<dt class="tron-text-muted">Sync Status</dt>
					<dd>
						{#if data.lastSyncStatus === 'success'}
							<TronBadge variant="success">Success</TronBadge>
						{:else if data.lastSyncStatus === 'error'}
							<TronBadge variant="error">Error</TronBadge>
						{:else if data.lastSyncStatus === 'in_progress'}
							<TronBadge variant="warning">In Progress</TronBadge>
						{:else}
							<TronBadge variant="neutral">{data.lastSyncStatus}</TronBadge>
						{/if}
					</dd>
				</div>
			{/if}
			{#if data.lastSyncError}
				<div class="flex justify-between">
					<dt class="tron-text-muted">Last Error</dt>
					<dd class="text-sm text-[var(--color-tron-red)]">{data.lastSyncError}</dd>
				</div>
			{/if}
		</dl>
	</TronCard>

	<!-- Access Token -->
	<TronCard>
		<h3 class="tron-text-primary mb-4 text-lg font-medium">Access Token</h3>
		<form
			method="POST"
			action="?/saveToken"
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					saving = false;
					await update();
				};
			}}
			class="space-y-4"
		>
			<div>
				<label for="accessToken" class="tron-label">Particle Access Token</label>
				<input
					id="accessToken"
					name="accessToken"
					type="password"
					class="tron-input"
					placeholder="Enter your Particle Cloud access token"
					required
					disabled={saving}
					style="min-height: 44px;"
				/>
				<p class="tron-text-muted mt-1 text-xs">
					Generate at console.particle.io &rarr; Authentication &rarr; Access Tokens
				</p>
			</div>

			<div class="flex gap-3">
				<TronButton type="submit" variant="primary" disabled={saving}>
					{saving ? 'Saving...' : 'Save Token'}
				</TronButton>
			</div>
		</form>
	</TronCard>

	<!-- Actions -->
	{#if data.hasToken}
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Actions</h3>
			<div class="flex flex-wrap gap-3">
				<form
					method="POST"
					action="?/testConnection"
					use:enhance={() => {
						testing = true;
						return async ({ update }) => {
							testing = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" variant="primary" disabled={testing} style="min-height: 44px;">
						{testing ? 'Testing...' : 'Test Connection'}
					</TronButton>
				</form>

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
					<TronButton type="submit" variant="primary" disabled={syncing} style="min-height: 44px;">
						{syncing ? 'Syncing...' : 'Sync Now'}
					</TronButton>
				</form>

				<form
					method="POST"
					action="?/linkToSpus"
					use:enhance={() => {
						linking = true;
						return async ({ update }) => {
							linking = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" variant="primary" disabled={linking} style="min-height: 44px;">
						{linking ? 'Linking...' : 'Link Devices to SPUs'}
					</TronButton>
				</form>

				<form
					method="POST"
					action="?/disconnect"
					use:enhance={() => {
						disconnecting = true;
						return async ({ update }) => {
							disconnecting = false;
							await update();
						};
					}}
				>
					<TronButton type="submit" disabled={disconnecting} style="min-height: 44px;">
						{disconnecting ? 'Disconnecting...' : 'Disconnect'}
					</TronButton>
				</form>
			</div>
		</TronCard>
	{/if}

	<!-- Messages -->
	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}
	{#if form?.success && form?.message}
		<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-green)]">{form.message}</p>
			{#if form?.unmatched?.length}
				<details class="mt-2">
					<summary class="tron-text-muted cursor-pointer text-xs">Unmatched devices ({form.unmatched.length})</summary>
					<ul class="tron-text-muted mt-1 list-inside list-disc text-xs">
						{#each form.unmatched as name}
							<li>{name}</li>
						{/each}
					</ul>
				</details>
			{/if}
		</div>
	{/if}

	<!-- Navigation -->
	<div class="flex gap-3">
		<a href='/'">
			<TronButton variant="primary" style="min-height: 44px;">Back to Dashboard</TronButton>
		</a>
	</div>
</div>
