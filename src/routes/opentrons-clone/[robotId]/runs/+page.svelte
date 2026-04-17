<script lang="ts">
	let { data } = $props();

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
</script>

<div class="mb-4 flex items-center justify-between">
	<div>
		<a href={`/opentrons-clone/${data.robot._id}`} class="text-sm text-blue-600 hover:underline">← {data.robot.name}</a>
		<h2 class="text-xl font-semibold mt-1">Runs</h2>
	</div>
	<span class="text-xs {data.online ? 'text-green-600' : 'text-red-600'}">
		{data.online ? 'Live' : 'Robot offline'}
	</span>
</div>

<section class="bg-white border rounded-lg p-4">
	{#if data.runs.length === 0}
		<p class="text-sm text-gray-500">No runs on this robot.</p>
	{:else}
		<table class="w-full text-sm">
			<thead class="text-gray-400 text-left">
				<tr>
					<th class="py-1">Run ID</th>
					<th>Status</th>
					<th>Current</th>
					<th>Created</th>
					<th>Errors</th>
				</tr>
			</thead>
			<tbody>
				{#each data.runs as run (run.id)}
					<tr class="border-t">
						<td class="py-2">
							<a href={`/opentrons-clone/${data.robot._id}/runs/${run.id}`} class="text-blue-600 hover:underline font-mono text-xs">
								{run.id}
							</a>
						</td>
						<td>
							<span class="text-xs px-1.5 py-0.5 rounded {statusClass(run.status)}">
								{run.status}
							</span>
						</td>
						<td class="text-xs">{run.current ? '●' : ''}</td>
						<td class="text-xs text-gray-600">{fmtDate(run.createdAt)}</td>
						<td class="text-xs {run.errors?.length ? 'text-red-600' : 'text-gray-500'}">
							{run.errors?.length ?? 0}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>
