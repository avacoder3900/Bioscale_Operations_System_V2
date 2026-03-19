<script lang="ts">
	let { data } = $props();

	let expandedEvent = $state<string | null>(null);

	const d = $derived(data.device);

	function relativeTime(date: Date | string | null): string {
		if (!date) return 'Never';
		const ms = Date.now() - new Date(date).getTime();
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	function formatTimestamp(date: Date | string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}

	function getEventColor(eventType: string): string {
		const colors: Record<string, string> = {
			validate: 'var(--color-tron-cyan, #00ffff)',
			load_assay: '#3b82f6',
			upload: 'var(--color-tron-green, #39ff14)',
			reset: '#f97316',
			error: '#ef4444'
		};
		return colors[eventType] ?? 'var(--color-tron-text-secondary, #9ca3af)';
	}

	function getEventBg(eventType: string): string {
		const bgs: Record<string, string> = {
			validate: 'rgba(0, 255, 255, 0.12)',
			load_assay: 'rgba(59, 130, 246, 0.12)',
			upload: 'rgba(57, 255, 20, 0.12)',
			reset: 'rgba(249, 115, 22, 0.12)',
			error: 'rgba(239, 68, 68, 0.12)'
		};
		return bgs[eventType] ?? 'rgba(107, 114, 128, 0.12)';
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<!-- Header -->
	<div>
		<a href="/devices" class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
			&larr; Back to Devices
		</a>
		<div class="mt-1 flex items-center gap-3">
			<div
				class="h-3 w-3 rounded-full"
				style="background: {d.isOnline
					? 'var(--color-tron-green, #39ff14)'
					: 'var(--color-tron-text-secondary, #6b7280)'}"
			></div>
			<h1 class="font-mono text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				{d.deviceId}
			</h1>
			<span
				class="rounded px-2 py-0.5 text-xs font-medium"
				style="background: {d.isOnline
					? 'rgba(57, 255, 20, 0.15)'
					: 'rgba(107, 114, 128, 0.15)'}; color: {d.isOnline
					? 'var(--color-tron-green, #39ff14)'
					: 'var(--color-tron-text-secondary, #6b7280)'}"
			>
				{d.isOnline ? 'Online' : 'Offline'}
			</span>
		</div>
	</div>

	<!-- Metadata Grid -->
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<div class="tron-card p-4">
			<div class="text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Last Seen</div>
			<div class="mt-1 font-medium" style="color: var(--color-tron-text-primary, #e5e7eb)">
				{relativeTime(d.lastSeen)}
			</div>
			<div class="mt-0.5 text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
				{formatTimestamp(d.lastSeen)}
			</div>
		</div>
		<div class="tron-card p-4">
			<div class="text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Firmware Version
			</div>
			<div
				class="mt-1 font-mono font-medium"
				style="color: var(--color-tron-text-primary, #e5e7eb)"
			>
				{d.firmwareVersion ?? '—'}
			</div>
		</div>
		<div class="tron-card p-4">
			<div class="text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">Tests Run</div>
			<div class="mt-1 text-lg font-bold" style="color: var(--color-tron-cyan, #00ffff)">
				{d.testCount}
			</div>
		</div>
		<div class="tron-card p-4">
			<div class="text-xs" style="color: var(--color-tron-text-secondary, #9ca3af)">
				Cartridges Validated
			</div>
			<div class="mt-1 text-lg font-bold" style="color: var(--color-tron-green, #39ff14)">
				{d.cartridgesValidatedCount}
			</div>
		</div>
	</div>

	<!-- Additional Metadata -->
	<div class="tron-card p-4">
		<h2 class="mb-3 text-sm font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
			Device Info
		</h2>
		<div class="grid gap-3 text-sm sm:grid-cols-2">
			<div>
				<span style="color: var(--color-tron-text-secondary, #9ca3af)">Data Format Version:</span>
				<span class="ml-2 font-mono" style="color: var(--color-tron-text-primary, #e5e7eb)">
					{d.dataFormatVersion ?? '—'}
				</span>
			</div>
			<div>
				<span style="color: var(--color-tron-text-secondary, #9ca3af)">Registered:</span>
				<span class="ml-2" style="color: var(--color-tron-text-primary, #e5e7eb)">
					{formatTimestamp(d.createdAt)}
				</span>
			</div>
			{#if d.metadata}
				<div class="sm:col-span-2">
					<span style="color: var(--color-tron-text-secondary, #9ca3af)">Metadata:</span>
					<pre
						class="mt-1 overflow-x-auto rounded p-2 font-mono text-xs"
						style="background: var(--color-tron-bg-tertiary, #1e1e2e); color: var(--color-tron-text-primary, #e5e7eb)">{JSON.stringify(
							d.metadata,
							null,
							2
						)}</pre>
				</div>
			{/if}
		</div>
	</div>

	<!-- Event Timeline -->
	<div>
		<h2 class="mb-3 text-lg font-semibold" style="color: var(--color-tron-cyan, #00ffff)">
			Event Timeline
		</h2>

		{#if data.events.length === 0}
			<div class="tron-card p-6 text-center">
				<p style="color: var(--color-tron-text-secondary, #9ca3af)">
					No events recorded for this device.
				</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each data.events as event (event.id)}
					<button
						type="button"
						class="tron-card w-full cursor-pointer p-3 text-left transition-all duration-150 hover:border-[var(--color-tron-cyan)]"
						style="min-height: 44px"
						onclick={() => (expandedEvent = expandedEvent === event.id ? null : event.id)}
					>
						<div class="flex items-center gap-3">
							<!-- Event type badge -->
							<span
								class="inline-block min-w-[90px] rounded px-2 py-0.5 text-center text-xs font-semibold"
								style="background: {getEventBg(event.eventType)}; color: {getEventColor(
									event.eventType
								)}"
							>
								{event.eventType}
							</span>

							<!-- Success/Failure -->
							{#if event.success === true}
								<span class="text-xs" style="color: var(--color-tron-green, #39ff14)">
									Success
								</span>
							{:else if event.success === false}
								<span class="text-xs" style="color: #ef4444">Failed</span>
							{/if}

							<!-- Cartridge UUID -->
							{#if event.cartridgeUuid}
								<span
									class="font-mono text-xs"
									style="color: var(--color-tron-text-secondary, #9ca3af)"
								>
									{event.cartridgeUuid}
								</span>
							{/if}

							<!-- Timestamp (pushed right) -->
							<span
								class="ml-auto text-xs"
								style="color: var(--color-tron-text-secondary, #9ca3af)"
							>
								{formatTimestamp(event.createdAt)}
							</span>
						</div>

						<!-- Error message -->
						{#if event.errorMessage}
							<div class="mt-1 text-xs" style="color: #ef4444">
								{event.errorMessage}
							</div>
						{/if}

						<!-- Expanded event data -->
						{#if expandedEvent === event.id && event.eventData}
							<pre
								class="mt-2 overflow-x-auto rounded p-2 font-mono text-xs"
								style="background: var(--color-tron-bg-tertiary, #1e1e2e); color: var(--color-tron-text-primary, #e5e7eb)">{JSON.stringify(
									event.eventData,
									null,
									2
								)}</pre>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>
