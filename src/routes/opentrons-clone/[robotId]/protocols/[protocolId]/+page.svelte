<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	const mainFile = data.protocol?.files?.find((f: any) => f.role === 'main')?.name ?? 'Protocol';
	const labwareFiles = data.protocol?.files?.filter((f: any) => f.role === 'labware') ?? [];
	const a = data.latestAnalysis;

	const analysisDocUrl = data.analyses.length
		? `/api/opentrons-clone/robots/${data.robot._id}/protocols/${data.protocolId}/analysis/${data.analyses[data.analyses.length - 1].id}/document`
		: null;
</script>

<div class="mb-4 flex items-center justify-between">
	<div>
		<a href={`/opentrons-clone/${data.robot._id}/protocols`} class="text-sm text-blue-600 hover:underline">
			← Protocols on {data.robot.name}
		</a>
		<h2 class="text-xl font-semibold mt-1 break-all">{mainFile}</h2>
		<p class="text-xs font-mono text-gray-400">{data.protocolId}</p>
	</div>
	<span class="text-xs {data.online ? 'text-green-600' : 'text-red-600'}">
		{data.online ? 'Live' : 'Robot offline'}
	</span>
</div>

{#if form?.error}
	<div class="bg-red-50 border border-red-300 text-red-900 rounded p-2 mb-3 text-sm">
		{form.error}
	</div>
{/if}

{#if !data.protocol}
	<p class="text-gray-500 text-sm">Protocol could not be loaded.</p>
{:else}
	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Overview</h3>
		<dl class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
			<div><dt class="text-gray-400 text-xs">Uploaded</dt><dd>{fmtDate(data.protocol.createdAt)}</dd></div>
			<div><dt class="text-gray-400 text-xs">Files</dt><dd>{data.protocol.files?.length ?? 0}</dd></div>
			<div class="md:col-span-2">
				<dt class="text-gray-400 text-xs">Labware files ({labwareFiles.length})</dt>
				<dd class="text-xs text-gray-600 max-h-24 overflow-y-auto">
					{#each labwareFiles as f (f.name)}
						<div class="font-mono">{f.name}</div>
					{/each}
				</dd>
			</div>
		</dl>
		<p class="text-xs text-gray-500 mt-3">
			Note: OT-2 API 8.7.0 does not expose raw <code>.py</code> download. Use the analysis document link below for a
			processed JSON representation, or open the Opentrons App on the lab Mac for the original source.
		</p>
	</section>

	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Analysis ({data.analyses.length} run{data.analyses.length === 1 ? '' : 's'})</h3>
		{#if !a}
			<p class="text-sm text-gray-500">No completed analysis available.</p>
		{:else}
			<div class="text-sm space-y-3">
				<dl class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
					<div><dt class="text-gray-400">Status</dt><dd>{a.status ?? '—'}</dd></div>
					<div><dt class="text-gray-400">Result</dt><dd>{a.result ?? '—'}</dd></div>
					<div><dt class="text-gray-400">Robot type</dt><dd>{a.robotType ?? '—'}</dd></div>
					<div><dt class="text-gray-400">Errors</dt><dd>{a.errors?.length ?? 0}</dd></div>
				</dl>

				{#if a.runTimeParameters?.length}
					<div>
						<h4 class="text-gray-700 font-medium text-xs mb-1">Runtime parameters ({a.runTimeParameters.length})</h4>
						<table class="text-xs w-full">
							<thead class="text-gray-400 text-left">
								<tr><th>Name</th><th>Type</th><th>Default</th><th>Value</th></tr>
							</thead>
							<tbody>
								{#each a.runTimeParameters.slice(0, 10) as rtp (rtp.variableName)}
									<tr class="border-t">
										<td class="py-1 font-mono">{rtp.variableName}</td>
										<td>{rtp.type}</td>
										<td>{String(rtp.default)}</td>
										<td>{String(rtp.value)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
						{#if a.runTimeParameters.length > 10}
							<p class="text-xs text-gray-400 mt-1">+{a.runTimeParameters.length - 10} more</p>
						{/if}
					</div>
				{/if}

				{#if a.pipettes?.length}
					<div>
						<h4 class="text-gray-700 font-medium text-xs mb-1">Pipettes required</h4>
						<ul class="text-xs list-disc list-inside">
							{#each a.pipettes as p (p.id ?? p.pipetteName + p.mount)}
								<li>{p.pipetteName ?? '—'} on {p.mount ?? '—'}</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if a.labware?.length}
					<div>
						<h4 class="text-gray-700 font-medium text-xs mb-1">Labware ({a.labware.length})</h4>
						<ul class="text-xs list-disc list-inside max-h-40 overflow-y-auto">
							{#each a.labware as lw (lw.id)}
								<li>{lw.loadName} @ slot {lw.location?.slotName ?? '—'} {lw.namespace !== 'opentrons' ? '(custom)' : ''}</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if analysisDocUrl}
					<a
						href={analysisDocUrl}
						target="_blank"
						rel="noopener"
						class="text-xs text-blue-600 hover:underline inline-block mt-2"
					>
						Download full analysis document (JSON) →
					</a>
				{/if}
			</div>
		{/if}
	</section>

	<section class="bg-white border rounded-lg p-4 mb-4">
		<h3 class="font-semibold mb-2">Start a run</h3>
		<form method="POST" action="?/createRun" use:enhance>
			<button
				type="submit"
				disabled={!data.online || !data.protocol}
				class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
			>
				Create run from this protocol
			</button>
			<p class="text-xs text-gray-500 mt-2">
				This creates an idle run on the robot using the current analysis's runtime parameters. You'll
				be redirected to the run detail page where you can press Play.
			</p>
		</form>
	</section>

	<section class="bg-white border rounded-lg p-4">
		<h3 class="font-semibold mb-2 text-red-700">Danger zone</h3>
		<form method="POST" action="?/delete" use:enhance>
			<button
				type="submit"
				onclick={(e) => {
					if (!confirm(`Delete protocol ${mainFile}? This cannot be undone.`)) e.preventDefault();
				}}
				class="px-3 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700"
			>
				Delete protocol from robot
			</button>
		</form>
	</section>
{/if}
