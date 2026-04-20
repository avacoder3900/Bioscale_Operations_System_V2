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

	type RtpParam = {
		variableName: string;
		displayName: string;
		description?: string | null;
		suffix?: string | null;
		type: 'int' | 'float' | 'bool' | 'str' | 'csv_file';
		default?: number | boolean | string;
		value?: number | boolean | string;
		min?: number;
		max?: number;
		choices?: Array<{ displayName: string; value: number | string }>;
		file?: { id: string; name: string } | null;
	};

	const rtpParams: RtpParam[] = (a?.runTimeParameters ?? []) as RtpParam[];
	const nonCsvParams = rtpParams.filter((p) => p.type !== 'csv_file');
	const csvParams = rtpParams.filter((p) => p.type === 'csv_file');

	const analysisPending = a ? a.status === 'pending' : false;
	const analysisHasErrors = (a?.errors?.length ?? 0) > 0;
	const analysisReady = !!a && !analysisPending && !analysisHasErrors;

	function initialValue(p: RtpParam): number | boolean | string {
		const v = p.value ?? p.default;
		if (p.type === 'bool') return typeof v === 'boolean' ? v : false;
		if (p.type === 'int') return typeof v === 'number' ? v : 0;
		if (p.type === 'float') return typeof v === 'number' ? v : 0;
		if (p.type === 'str') return v != null ? String(v) : '';
		return v ?? '';
	}

	const initValues: Record<string, number | boolean | string> = {};
	for (const p of nonCsvParams) initValues[p.variableName] = initialValue(p);

	const initFiles: Record<string, string> = {};
	for (const p of csvParams) initFiles[p.variableName] = p.file?.id ?? '';

	let values = $state<Record<string, number | boolean | string>>(initValues);
	let files = $state<Record<string, string>>(initFiles);

	const csvFileIds = new Set(data.dataFiles.map((f: any) => f.id as string));

	// Validation of current values — mirrors the server-side check for UX only.
	const valuesValid = $derived.by(() => {
		for (const p of nonCsvParams) {
			const v = values[p.variableName];
			if (p.type === 'bool') {
				if (typeof v !== 'boolean') return false;
				continue;
			}
			if (Array.isArray(p.choices)) {
				const allowed = p.choices.map((c) => c.value);
				const coerced = p.type === 'str' ? String(v) : Number(v);
				if (p.type !== 'str' && !Number.isFinite(coerced)) return false;
				if (!allowed.some((x) => x === coerced)) return false;
				continue;
			}
			if (p.type === 'int') {
				const n = Number(v);
				if (!Number.isInteger(n)) return false;
				if (typeof p.min === 'number' && n < p.min) return false;
				if (typeof p.max === 'number' && n > p.max) return false;
				continue;
			}
			if (p.type === 'float') {
				const n = Number(v);
				if (!Number.isFinite(n)) return false;
				if (typeof p.min === 'number' && n < p.min) return false;
				if (typeof p.max === 'number' && n > p.max) return false;
				continue;
			}
		}
		return true;
	});

	const filesValid = $derived.by(() => {
		for (const p of csvParams) {
			const id = files[p.variableName];
			if (id && csvFileIds.size > 0 && !csvFileIds.has(id)) return false;
		}
		return true;
	});

	const hasCsvParams = csvParams.length > 0;
	const csvBlocked = hasCsvParams && !data.dataFilesReachable;

	const canCreateRun = $derived(
		data.online && !!data.protocol && analysisReady && valuesValid && filesValid && !csvBlocked
	);

	// Strip empty-string CSV selections; send only values that are populated.
	const rtpValuesJson = $derived(JSON.stringify(values));
	const rtpFilesJson = $derived(
		JSON.stringify(
			Object.fromEntries(Object.entries(files).filter(([, v]) => v !== ''))
		)
	);
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

		{#if !a}
			<p class="text-xs text-gray-500 mb-2">Waiting for analysis to complete before a run can be created.</p>
		{:else if analysisPending}
			<p class="text-xs text-gray-500 mb-2">Analysis is still pending — runtime parameters are not yet available. Refresh shortly.</p>
		{:else if analysisHasErrors}
			<p class="text-xs text-red-700 mb-2">Analysis has errors; cannot create a run from this protocol.</p>
		{/if}

		<form method="POST" action="?/createRun" use:enhance>
			<input type="hidden" name="rtpValues" value={rtpValuesJson} />
			<input type="hidden" name="rtpFiles" value={rtpFilesJson} />

			{#if rtpParams.length > 0 && analysisReady}
				<div class="space-y-3 mb-4">
					<h4 class="text-gray-700 font-medium text-xs">Runtime parameters ({rtpParams.length})</h4>

					{#each nonCsvParams as p (p.variableName)}
						<fieldset class="border rounded p-2">
							<legend class="text-xs px-1">
								<span class="font-medium">{p.displayName}</span>
								<span class="font-mono text-gray-400 ml-1">{p.variableName}</span>
								<span class="text-gray-400 ml-1">({p.type})</span>
							</legend>
							{#if p.description}
								<p class="text-xs text-gray-500 mb-1">{p.description}</p>
							{/if}

							{#if p.type === 'bool'}
								<label class="inline-flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={values[p.variableName] === true}
										onchange={(e) => (values[p.variableName] = (e.target as HTMLInputElement).checked)}
									/>
									<span>{values[p.variableName] ? 'true' : 'false'}</span>
								</label>
							{:else if Array.isArray(p.choices)}
								<select
									class="text-sm border rounded px-2 py-1 w-full"
									value={String(values[p.variableName])}
									onchange={(e) => {
										const raw = (e.target as HTMLSelectElement).value;
										values[p.variableName] = p.type === 'str' ? raw : Number(raw);
									}}
								>
									{#each p.choices as c (String(c.value))}
										<option value={String(c.value)}>{c.displayName}</option>
									{/each}
								</select>
							{:else if p.type === 'int' || p.type === 'float'}
								<input
									type="number"
									class="text-sm border rounded px-2 py-1 w-full"
									step={p.type === 'int' ? 1 : 'any'}
									min={typeof p.min === 'number' ? p.min : undefined}
									max={typeof p.max === 'number' ? p.max : undefined}
									value={String(values[p.variableName])}
									oninput={(e) => {
										const raw = (e.target as HTMLInputElement).value;
										if (raw === '') {
											values[p.variableName] = p.type === 'int' ? 0 : 0;
											return;
										}
										values[p.variableName] = p.type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
									}}
								/>
								<p class="text-xs text-gray-400 mt-0.5">
									default {String(p.default)}
									{#if typeof p.min === 'number' || typeof p.max === 'number'}
										· range [{p.min ?? '−∞'}, {p.max ?? '∞'}]
									{/if}
									{#if p.suffix}· {p.suffix}{/if}
								</p>
							{/if}
						</fieldset>
					{/each}

					{#if csvParams.length > 0}
						{#if !data.dataFilesReachable}
							<p class="text-xs text-red-700">Robot's /dataFiles is unreachable — CSV parameters cannot be chosen.</p>
						{/if}
						{#each csvParams as p (p.variableName)}
							<fieldset class="border rounded p-2">
								<legend class="text-xs px-1">
									<span class="font-medium">{p.displayName}</span>
									<span class="font-mono text-gray-400 ml-1">{p.variableName}</span>
									<span class="text-gray-400 ml-1">(csv_file)</span>
								</legend>
								{#if p.description}
									<p class="text-xs text-gray-500 mb-1">{p.description}</p>
								{/if}
								<select
									class="text-sm border rounded px-2 py-1 w-full"
									value={files[p.variableName] ?? ''}
									disabled={!data.dataFilesReachable}
									onchange={(e) => (files[p.variableName] = (e.target as HTMLSelectElement).value)}
								>
									<option value="">(none)</option>
									{#each data.dataFiles as df (df.id)}
										<option value={df.id}>{df.name}</option>
									{/each}
								</select>
								{#if data.dataFiles.length === 0 && data.dataFilesReachable}
									<p class="text-xs text-gray-500 mt-1">
										No data files uploaded.
										<a class="text-blue-600 hover:underline" href={`/opentrons-clone/${data.robot._id}/data-files`}>
											Upload one →
										</a>
									</p>
								{/if}
							</fieldset>
						{/each}
					{/if}
				</div>
			{/if}

			<button
				type="submit"
				disabled={!canCreateRun}
				onclick={(e) => {
					if (!confirm(`Create a new run from ${mainFile}?`)) e.preventDefault();
				}}
				class="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
			>
				Create run from this protocol
			</button>
			<p class="text-xs text-gray-500 mt-2">
				This creates an idle run on the robot with the parameters above. You'll be redirected to the run detail page where
				you can press Play.
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
