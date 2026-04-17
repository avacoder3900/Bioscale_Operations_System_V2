<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';

	let { data, form } = $props();

	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	function statusClass(status: string): string {
		switch (status) {
			case 'running':
			case 'finishing':
				return 'bg-blue-100 text-blue-700';
			case 'succeeded':
				return 'bg-green-100 text-green-700';
			case 'paused':
			case 'awaiting-recovery':
				return 'bg-amber-100 text-amber-700';
			case 'failed':
			case 'stopped':
				return 'bg-red-100 text-red-700';
			default:
				return 'bg-gray-100 text-gray-600';
		}
	}

	// Auto-refresh while a run is active (polling per plan §2.3)
	let poll: ReturnType<typeof setInterval> | null = null;
	const ACTIVE = ['running', 'paused', 'finishing', 'awaiting-recovery', 'idle'];

	onMount(() => {
		if (data.run && ACTIVE.includes(data.run.status)) {
			poll = setInterval(() => invalidateAll(), 3000);
		}
	});
	onDestroy(() => {
		if (poll) clearInterval(poll);
	});

	// Restart polling if status flips between fetches
	$effect(() => {
		const active = data.run && ACTIVE.includes(data.run.status);
		if (active && !poll) poll = setInterval(() => invalidateAll(), 3000);
		if (!active && poll) {
			clearInterval(poll);
			poll = null;
		}
	});

	function cmdSummary(c: any): string {
		const type = c.commandType ?? 'cmd';
		if (c.params?.labwareId) return `${type} → labware ${c.params.labwareId}`;
		if (c.params?.pipetteId) return `${type} (${c.params.pipetteId})`;
		return type;
	}
</script>

<div class="mb-4">
	<a href={`/opentrons-clone/${data.robot._id}/runs`} class="text-sm text-blue-600 hover:underline">
		← Runs on {data.robot.name}
	</a>
	<h2 class="text-xl font-semibold mt-1 font-mono">{data.runId}</h2>
</div>

{#if form?.error}
	<div class="bg-red-50 border border-red-300 text-red-900 rounded p-2 mb-3 text-sm">{form.error}</div>
{/if}

{#if !data.run}
	<p class="text-gray-500 text-sm">Run could not be loaded.</p>
{:else}
	<section class="bg-white border rounded-lg p-4 mb-4">
		<div class="flex items-center justify-between mb-3">
			<div class="flex items-center gap-2">
				<span class="text-xs px-2 py-0.5 rounded {statusClass(data.run.status)}">
					{data.run.status}
				</span>
				{#if data.run.current}
					<span class="text-xs text-blue-600">● current</span>
				{/if}
			</div>
			<span class="text-xs {data.online ? 'text-green-600' : 'text-red-600'}">
				{data.online ? 'Live (3s poll)' : 'Robot offline'}
			</span>
		</div>
		<dl class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
			<div><dt class="text-gray-400">Created</dt><dd>{fmtDate(data.run.createdAt)}</dd></div>
			<div><dt class="text-gray-400">Started</dt><dd>{fmtDate(data.run.startedAt)}</dd></div>
			<div><dt class="text-gray-400">Completed</dt><dd>{fmtDate(data.run.completedAt)}</dd></div>
			<div><dt class="text-gray-400">Protocol</dt><dd class="font-mono truncate" title={data.run.protocolId}>{data.run.protocolId ?? '—'}</dd></div>
		</dl>
	</section>

	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Actions</h3>
		<div class="flex flex-wrap gap-2">
			{#each ['play', 'pause', 'stop', 'resume-from-recovery'] as actionType (actionType)}
				<form
					method="POST"
					action="?/action"
					use:enhance={() => async ({ result }) => {
						if (result.type === 'success') await invalidateAll();
					}}
					class="inline"
				>
					<input type="hidden" name="actionType" value={actionType} />
					<button
						type="submit"
						disabled={!data.online}
						class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-sm rounded disabled:opacity-50 capitalize"
					>
						{actionType.replace(/-/g, ' ')}
					</button>
				</form>
			{/each}
		</div>
		<p class="text-xs text-gray-500 mt-2">
			Actions are enqueued on the robot; result status will appear after the next poll.
		</p>
	</section>

	{#if data.currentState}
		<section class="bg-white border rounded-lg p-4 mb-4">
			<h3 class="font-semibold mb-2">Current state</h3>
			<dl class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
				{#if data.currentState.activeCommand}
					<div class="md:col-span-3"><dt class="text-gray-400">Active command</dt><dd class="font-mono">{cmdSummary(data.currentState.activeCommand)}</dd></div>
				{/if}
				<div><dt class="text-gray-400">Placements</dt><dd>{data.currentState.placements?.length ?? 0}</dd></div>
				<div><dt class="text-gray-400">Tip states</dt><dd>{Object.keys(data.currentState.tipStates ?? {}).length}</dd></div>
				<div><dt class="text-gray-400">Errors</dt><dd class={data.currentState.errors?.length ? 'text-red-600' : ''}>{data.currentState.errors?.length ?? 0}</dd></div>
			</dl>
		</section>
	{/if}

	{#if data.commandErrors.length > 0}
		<section class="bg-red-50 border border-red-300 rounded-lg p-4 mb-4">
			<h3 class="font-semibold text-red-800 mb-2">Command errors ({data.commandErrors.length})</h3>
			<ul class="text-xs space-y-2">
				{#each data.commandErrors.slice(0, 10) as err (err.id)}
					<li class="font-mono">
						<span class="text-red-700">{err.errorType ?? 'error'}:</span> {err.detail ?? '—'}
						<span class="text-gray-500 ml-2">{fmtDate(err.createdAt)}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Commands ({data.commands.length} shown)</h3>
		{#if data.commands.length === 0}
			<p class="text-sm text-gray-500">No commands yet.</p>
		{:else}
			<div class="max-h-[400px] overflow-y-auto">
				<table class="w-full text-xs">
					<thead class="text-gray-400 text-left sticky top-0 bg-white">
						<tr>
							<th class="py-1">#</th>
							<th>Type</th>
							<th>Status</th>
							<th>Started</th>
							<th>Completed</th>
						</tr>
					</thead>
					<tbody>
						{#each data.commands as cmd, i (cmd.id)}
							<tr class="border-t">
								<td class="py-1 text-gray-400">{i + 1}</td>
								<td class="font-mono">{cmd.commandType}</td>
								<td>
									<span class="px-1 py-0.5 rounded text-[10px] {statusClass(cmd.status)}">
										{cmd.status}
									</span>
								</td>
								<td class="text-gray-500">{cmd.startedAt ? new Date(cmd.startedAt).toLocaleTimeString() : '—'}</td>
								<td class="text-gray-500">{cmd.completedAt ? new Date(cmd.completedAt).toLocaleTimeString() : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Labware offsets ({data.run.labwareOffsets?.length ?? 0} applied)</h3>
		{#if data.run.labwareOffsets?.length}
			<table class="w-full text-xs mb-3">
				<thead class="text-gray-400 text-left">
					<tr><th>Labware URI</th><th>Slot</th><th>Offset (x/y/z)</th></tr>
				</thead>
				<tbody>
					{#each data.run.labwareOffsets as off (off.id)}
						<tr class="border-t">
							<td class="font-mono">{off.definitionUri}</td>
							<td>{off.location?.slotName ?? '—'}</td>
							<td class="font-mono">{off.vector ? `${off.vector.x.toFixed(2)} / ${off.vector.y.toFixed(2)} / ${off.vector.z.toFixed(2)}` : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
		<details class="text-sm">
			<summary class="cursor-pointer text-gray-600">Apply a per-run offset (advanced)</summary>
			<form method="POST" action="?/applyOffset" use:enhance class="mt-2 grid grid-cols-1 md:grid-cols-5 gap-2">
				<input name="definitionUri" placeholder="opentrons/..." class="border rounded px-2 py-1 text-xs md:col-span-2" required />
				<input name="slotName" placeholder="Slot (e.g. 1)" class="border rounded px-2 py-1 text-xs" required />
				<div class="grid grid-cols-3 gap-1 md:col-span-2">
					<input name="x" type="number" step="0.01" placeholder="x" class="border rounded px-2 py-1 text-xs" required />
					<input name="y" type="number" step="0.01" placeholder="y" class="border rounded px-2 py-1 text-xs" required />
					<input name="z" type="number" step="0.01" placeholder="z" class="border rounded px-2 py-1 text-xs" required />
				</div>
				<button
					type="submit"
					disabled={!data.online}
					class="md:col-span-5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-xs rounded disabled:opacity-50 justify-self-start"
				>
					Apply offset
				</button>
			</form>
			<p class="text-xs text-gray-500 mt-2">
				The Opentrons App's Labware Position Check wizard is the normal way to find offset values. This form lets
				power users apply known offsets without leaving BIMS.
			</p>
		</details>
	</section>

	<section class="bg-white border rounded-lg p-4">
		<h3 class="font-semibold mb-2 text-red-700">Danger zone</h3>
		<form method="POST" action="?/delete" use:enhance>
			<button
				type="submit"
				onclick={(e) => {
					if (!confirm(`Delete run ${data.runId}? This cannot be undone.`)) e.preventDefault();
				}}
				class="px-3 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700"
			>
				Delete run
			</button>
		</form>
	</section>
{/if}
