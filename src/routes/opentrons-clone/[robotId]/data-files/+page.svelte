<script lang="ts">
	import { cloneForm, guardWrite, type CloneFormResult } from '../../clone-form';
	import { cloneLine } from '../../clone-session';
	import { dataFilesActions, downloadFile, lookupClientData as lookupOnRobot } from '../../clone-api';

	let { data } = $props();

	// OT2-TAILNET-5 S10b: actions run in the browser over the robot session.
	let form = $state<CloneFormResult>(null);
	const line = $derived(cloneLine(data.robot._id));
	const actions = $derived(guardWrite(data.canWrite, dataFilesActions(line)));
	const onResult = (r: CloneFormResult) => (form = r);

	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	async function downloadDataFile(df: any) {
		const err = await downloadFile(line, `/dataFiles/${encodeURIComponent(df.id)}/download`, df.name ?? df.id);
		if (err) form = { error: `Download failed — ${err}` };
	}

	let clientKey = $state('');
	let lookupResult = $state<string | null>(null);
	let lookupError = $state<string | null>(null);

	async function lookupClientData() {
		lookupResult = null;
		lookupError = null;
		if (!clientKey.trim()) return;
		try {
			const res = await lookupOnRobot(line, clientKey.trim());
			if (res.status < 200 || res.status >= 300) {
				lookupError = `HTTP ${res.status}`;
				return;
			}
			lookupResult = JSON.stringify(res.body, null, 2);
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
		use:cloneForm={{ actions, onResult }}
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
								href={`#${df.id}`}
								onclick={(e) => { e.preventDefault(); void downloadDataFile(df); }}
								class="text-blue-600 hover:underline mr-2"
							>
								download
							</a>
							<form
								method="POST"
								action="?/deleteDataFile"
								use:cloneForm={{ actions, onResult }}
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
		use:cloneForm={{ actions, onResult }}
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
		use:cloneForm={{ actions, onResult }}
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
