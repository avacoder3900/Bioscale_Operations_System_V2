<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();

	let uploading = $state(false);

	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	function mainFileName(p: any): string {
		return p.files?.find((f: any) => f.role === 'main')?.name ?? '(no main)';
	}
</script>

<div class="mb-4 flex items-center justify-between">
	<div>
		<a href={`/opentrons-clone/${data.robot._id}`} class="text-sm text-blue-600 hover:underline">← {data.robot.name}</a>
		<h2 class="text-xl font-semibold mt-1">Protocols</h2>
	</div>
	<span class="text-xs {data.online ? 'text-green-600' : 'text-red-600'}">
		{data.online ? 'Live' : 'Robot offline'}
	</span>
</div>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-3">Upload protocol</h3>
	<form
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		use:enhance={() => {
			uploading = true;
			return async ({ result, update }) => {
				uploading = false;
				await update({ reset: true });
				if (result.type === 'success') await invalidateAll();
			};
		}}
		class="space-y-3 text-sm"
	>
		<div>
			<label class="block text-gray-600 text-xs mb-1" for="protocol">Main file (.py or .json)</label>
			<input id="protocol" name="protocol" type="file" accept=".py,.json" required class="text-sm" />
		</div>
		<div>
			<label class="block text-gray-600 text-xs mb-1" for="support">Support files (labware .json, optional)</label>
			<input id="support" name="support" type="file" multiple accept=".json,.csv" class="text-sm" />
		</div>
		<button
			type="submit"
			disabled={uploading || !data.online}
			class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded disabled:opacity-50 hover:bg-blue-700"
		>
			{uploading ? 'Uploading…' : 'Upload to robot'}
		</button>
		{#if form?.error}
			<p class="text-red-600 text-xs">{form.error}</p>
		{:else if form?.success}
			<p class="text-green-600 text-xs">Upload complete.</p>
		{/if}
	</form>
</section>

<section class="bg-white border rounded-lg p-4">
	<h3 class="font-semibold mb-3">On-robot protocols ({data.protocols.length})</h3>
	{#if data.protocols.length === 0}
		<p class="text-sm text-gray-500">No protocols on this robot.</p>
	{:else}
		<table class="w-full text-sm">
			<thead class="text-gray-400 text-left">
				<tr>
					<th class="py-1">Name / ID</th>
					<th>Uploaded</th>
					<th>Files</th>
					<th class="text-right">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.protocols as p (p.id)}
					<tr class="border-t">
						<td class="py-2">
							<a href={`/opentrons-clone/${data.robot._id}/protocols/${p.id}`} class="text-blue-600 hover:underline">
								{mainFileName(p)}
							</a>
							<div class="text-xs text-gray-400 font-mono">{p.id}</div>
						</td>
						<td class="text-xs text-gray-600">{fmtDate(p.createdAt)}</td>
						<td class="text-xs text-gray-600">{p.files?.length ?? 0}</td>
						<td class="text-right">
							<form
								method="POST"
								action="?/delete"
								use:enhance={() => async ({ result }) => {
									if (result.type === 'success') await invalidateAll();
								}}
								class="inline"
							>
								<input type="hidden" name="protocolId" value={p.id} />
								<button
									type="submit"
									onclick={(e) => {
										if (!confirm(`Delete protocol ${mainFileName(p)}?`)) e.preventDefault();
									}}
									class="text-xs text-red-600 hover:underline"
								>
									Delete
								</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>
