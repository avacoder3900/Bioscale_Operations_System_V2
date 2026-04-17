<script lang="ts">
	let { data } = $props();

	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}
</script>

<div class="mb-4">
	<a href={`/opentrons-clone/${data.robot._id}`} class="text-sm text-blue-600 hover:underline">← {data.robot.name}</a>
	<h2 class="text-xl font-semibold mt-1">Labware</h2>
</div>

<div class="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm">
	<strong>Note:</strong> OT-2 API 8.7.0 does not expose a labware definitions list endpoint
	(<code>/labware/calibrations</code> was removed). Labware definitions are scoped to runs —
	see <a href={`/opentrons-clone/${data.robot._id}/runs`} class="text-blue-700 hover:underline">/runs</a>
	and each run's "loaded labware" in its detail view.
</div>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Robot-level labware offsets</h3>
	{#if !data.online}
		<p class="text-sm text-red-600">Robot offline.</p>
	{:else if data.offsets.length === 0}
		<p class="text-sm text-gray-500">No robot-level offsets stored. Offsets are typically applied per-run.</p>
	{:else}
		<table class="w-full text-xs">
			<thead class="text-gray-400 text-left">
				<tr>
					<th class="py-1">ID</th>
					<th>Labware URI</th>
					<th>Location</th>
					<th>Offset (x/y/z)</th>
					<th>Created</th>
				</tr>
			</thead>
			<tbody>
				{#each data.offsets as off (off.id)}
					<tr class="border-t">
						<td class="py-1 font-mono text-gray-500">{off.id}</td>
						<td class="font-mono">{off.definitionUri ?? '—'}</td>
						<td>{off.location?.slotName ?? off.location?.moduleModel ?? '—'}</td>
						<td class="font-mono">
							{off.vector ? `${off.vector.x.toFixed(2)} / ${off.vector.y.toFixed(2)} / ${off.vector.z.toFixed(2)}` : '—'}
						</td>
						<td class="text-gray-500">{fmtDate(off.createdAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>
