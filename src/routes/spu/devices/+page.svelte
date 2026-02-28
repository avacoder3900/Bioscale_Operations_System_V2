<script lang="ts">
	let { data } = $props();

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
</script>

<div class="mx-auto max-w-7xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan, #00ffff)">Devices</h1>
		<span class="text-sm" style="color: var(--color-tron-text-secondary, #9ca3af)">
			{data.devices.length} registered device{data.devices.length !== 1 ? 's' : ''}
		</span>
	</div>

	{#if data.devices.length === 0}
		<div class="tron-card p-8 text-center">
			<p style="color: var(--color-tron-text-secondary, #9ca3af)">
				No devices registered yet. Devices appear here after connecting to the firmware backend.
			</p>
		</div>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.devices as device (device.id)}
				<a
					href="/spu/devices/{device.deviceId}"
					class="tron-card block p-4 transition-all duration-200 hover:border-[var(--color-tron-cyan)]"
					style="min-height: 44px"
				>
					<div class="mb-3 flex items-center justify-between">
						<div class="flex items-center gap-2">
							<div
								class="h-3 w-3 rounded-full"
								style="background: {device.isOnline
									? 'var(--color-tron-green, #39ff14)'
									: 'var(--color-tron-text-secondary, #6b7280)'}"
								title={device.isOnline ? 'Online' : 'Offline'}
							></div>
							<span
								class="font-mono text-sm font-bold"
								style="color: var(--color-tron-cyan, #00ffff)"
							>
								{device.deviceId.length > 20
									? device.deviceId.slice(0, 20) + '...'
									: device.deviceId}
							</span>
						</div>
						<span
							class="rounded px-2 py-0.5 text-xs font-medium"
							style="background: {device.isOnline
								? 'rgba(57, 255, 20, 0.15)'
								: 'rgba(107, 114, 128, 0.15)'}; color: {device.isOnline
								? 'var(--color-tron-green, #39ff14)'
								: 'var(--color-tron-text-secondary, #6b7280)'}"
						>
							{device.isOnline ? 'Online' : 'Offline'}
						</span>
					</div>

					<div class="space-y-1 text-sm">
						<div class="flex justify-between">
							<span style="color: var(--color-tron-text-secondary, #9ca3af)">Last Seen</span>
							<span style="color: var(--color-tron-text-primary, #e5e7eb)">
								{relativeTime(device.lastSeen)}
							</span>
						</div>
						<div class="flex justify-between">
							<span style="color: var(--color-tron-text-secondary, #9ca3af)">Firmware</span>
							<span style="color: var(--color-tron-text-primary, #e5e7eb)">
								{device.firmwareVersion ?? '—'}
							</span>
						</div>
						<div class="flex justify-between">
							<span style="color: var(--color-tron-text-secondary, #9ca3af)">Data Format</span>
							<span style="color: var(--color-tron-text-primary, #e5e7eb)">
								{device.dataFormatVersion ?? '—'}
							</span>
						</div>
						<div class="flex justify-between">
							<span style="color: var(--color-tron-text-secondary, #9ca3af)">Events</span>
							<span style="color: var(--color-tron-text-primary, #e5e7eb)">
								{device.eventCount}
							</span>
						</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
