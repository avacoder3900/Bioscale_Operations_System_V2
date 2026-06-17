<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();

	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	let clientKey = $state('');
	let lookupResult = $state<string | null>(null);
	let lookupError = $state<string | null>(null);

	async function lookupClientData() {
		lookupResult = null;
		lookupError = null;
		if (!clientKey.trim()) return;
		try {
			const res = await fetch(
				`/api/opentrons-clone/robots/${data.robot._id}/client-data/${encodeURIComponent(clientKey.trim())}`
			);
			if (!res.ok) {
				lookupError = `HTTP ${res.status}`;
				return;
			}
			lookupResult = JSON.stringify(await res.json(), null, 2);
		} catch (e) {
			lookupError = (e as Error).message;
		}
	}
</script>

<div class="mb-4">
	<a href={`/opentrons-clone/${data.robot._id}`} class="text-sm text-blue-600 hover:underline">← {data.robot.name}</a>
	<h2 class="text-xl font-semibold mt-1">Data files &amp; client data</h2>
</div>

{#if form?.error}
	<div class="bg-red-50 border border-red-300 text-red-900 rounded p-2 mb-3 text-sm">{form.error}</div>
{:else if form?.success}
	<div class="bg-green-50 border border-green-300 text-green-900 rounded p-2 mb-3 text-sm">{form.message ?? 'OK'}</div>
{/if}

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Data files ({data.dataFiles.length})</h3>
	<p class="text-xs text-gray-500 mb-3">Used for runtime parameter CSVs and similar inputs to protocols.</p>

	<form
		method="POST"
		action="?/uploadDataFile"
		enctype="multipart/form-data"
		use:enhance={() => async ({ result, update }) => {
			await update({ reset: true });
			if (result.type === 'success') await invalidateAll();
		}}
		class="flex items-center gap-2 mb-4"
	>
		<input type="file" name="file" required class="text-sm" />
		<button type="submit" disabled={!data.online} class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded disabled:opacity-50 hover:bg-blue-700">
			Upload data file
		</button>
	</form>

	{#if data.dataFiles.length === 0}
		<p class="text-sm text-gray-500">No data files on this robot.</p>
	{:else}
		<table class="w-full text-xs">
			<thead class="text-gray-400 text-left">
				<tr><th class="py-1">Name</th><th>Size</th><th>Created</th><th>ID</th><th class="text-right">Actions</th></tr>
			</thead>
			<tbody>
				{#each data.dataFiles as df (df.id)}
					<tr class="border-t">
						<td class="py-1">{df.name}</td>
						<td class="text-gray-500">{df.fileSize ? `${df.fileSize} B` : '—'}</td>
						<td class="text-gray-500">{fmtDate(df.createdAt)}</td>
						<td class="font-mono text-gray-500">{df.id}</td>
						<td class="text-right">
							<a
								href={`/api/opentrons-clone/robots/${data.robot._id}/data-files/${df.id}/download`}
								target="_blank"
								rel="noopener"
								class="text-blue-600 hover:underline mr-2"
							>
								download
							</a>
							<form
								method="POST"
								action="?/deleteDataFile"
								use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}
								class="inline"
							>
								<input type="hidden" name="id" value={df.id} />
								<button type="submit" class="text-red-600 hover:underline" onclick={(e) => { if (!confirm(`Delete ${df.name}?`)) e.preventDefault(); }}>
									delete
								</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<section class="bg-white border rounded-lg p-4">
	<h3 class="font-semibold mb-2">Client data (K/V store on robot)</h3>
	<p class="text-xs text-gray-500 mb-3">
		Arbitrary key/value storage on the robot — handy for batch/lot stamps without persisting to our DB.
	</p>

	<div class="flex items-end gap-2 mb-3 text-sm">
		<div class="flex-1">
			<label class="block text-xs text-gray-600 mb-1" for="client-key">Key</label>
			<input id="client-key" bind:value={clientKey} type="text" class="w-full border rounded px-2 py-1 text-sm" />
		</div>
		<button type="button" onclick={lookupClientData} class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-sm rounded">Lookup</button>
	</div>
	{#if lookupError}<pre class="text-xs text-red-600 mb-3">{lookupError}</pre>{/if}
	{#if lookupResult}<pre class="text-xs bg-gray-50 p-2 rounded mb-3 max-h-40 overflow-auto">{lookupResult}</pre>{/if}

	<form
		method="POST"
		action="?/setClientData"
		use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}
		class="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3"
	>
		<input name="key" placeholder="key" class="border rounded px-2 py-1 text-sm" required />
		<input name="value" placeholder='value (JSON or string)' class="border rounded px-2 py-1 text-sm md:col-span-1" required />
		<button
			type="submit"
			disabled={!data.online}
			class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-sm rounded disabled:opacity-50"
			onclick={(e) => { if (!confirm('Write this value to robot clientData?')) e.preventDefault(); }}
		>
			PUT client data
		</button>
	</form>

	<form
		method="POST"
		action="?/deleteClientData"
		use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}
		class="flex items-center gap-2"
	>
		<input name="key" placeholder="key (blank = clear all)" class="border rounded px-2 py-1 text-sm flex-1" />
		<button
			type="submit"
			disabled={!data.online}
			class="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-800 text-sm rounded disabled:opacity-50"
			onclick={(e) => {
				const k = (e.currentTarget as HTMLButtonElement).form?.key?.value;
				const msg = k ? `Delete clientData[${k}]?` : 'Clear ALL client data on this robot?';
				if (!confirm(msg)) e.preventDefault();
			}}
		>
			DELETE
		</button>
	</form>
</section>
