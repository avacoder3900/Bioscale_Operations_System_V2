<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		robotHealthStates,
		sseConnected,
		connectHealthSSE,
		disconnectHealthSSE,
		type RobotHealth
	} from '$lib/stores/robot-health';

	let { data } = $props();

	onMount(() => connectHealthSSE());
	onDestroy(() => disconnectHealthSSE());

	function healthFor(robotId: string): RobotHealth | undefined {
		return $robotHealthStates.find((h) => h.robotId === robotId);
	}
</script>

<div class="mb-4 flex items-center justify-between">
	<h2 class="text-xl font-semibold">Robots</h2>
	<span class="text-xs {$sseConnected ? 'text-green-600' : 'text-amber-600'}">
		{$sseConnected ? '● Live' : '○ Reconnecting…'}
	</span>
</div>

{#if data.robots.length === 0}
	<p class="text-gray-500 text-sm">No active robots configured. Add one under /opentrons/devices.</p>
{:else}
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
		{#each data.robots as robot (robot._id)}
			{@const health = healthFor(robot._id)}
			{@const online = health?.isOnline ?? false}
			<a
				href={`/opentrons-clone/${robot._id}`}
				class="block bg-white border rounded-lg p-4 hover:shadow transition"
			>
				<div class="flex items-center justify-between mb-2">
					<h3 class="font-semibold">{robot.name}</h3>
					<span class="text-xs px-2 py-0.5 rounded-full {online ? 'bg-green-100 text-green-700' : health ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}">
						{#if !health}—{:else if online}Online{:else}Offline{/if}
					</span>
				</div>
				<dl class="text-xs text-gray-600 space-y-0.5">
					<div><span class="text-gray-400">IP:</span> {robot.ip}</div>
					<div><span class="text-gray-400">API:</span> {health?.apiVersion ?? '—'}</div>
					<div><span class="text-gray-400">Firmware:</span> {health?.firmwareVersion ?? '—'}</div>
					{#if health?.currentRunId}
						<div class="text-blue-700 mt-1">
							<span class="text-gray-400">Active run:</span> {health.currentRunStatus}
						</div>
					{/if}
					{#if health?.errorMessage}
						<div class="text-red-600 mt-1 truncate" title={health.errorMessage}>
							<span class="text-gray-400">Error:</span> {health.errorMessage}
						</div>
					{/if}
				</dl>
			</a>
		{/each}
	</div>
{/if}
