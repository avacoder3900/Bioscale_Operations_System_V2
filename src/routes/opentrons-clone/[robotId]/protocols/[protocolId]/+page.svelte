<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	let { data, form } = $props();

	type LpcOffset = {
		definitionUri: string;
		location: { slotName: string };
		vector: { x: number; y: number; z: number };
	};
	let lpcOffsets = $state<LpcOffset[]>([]);

	function isLpcOffset(raw: unknown): raw is LpcOffset {
		if (raw === null || typeof raw !== 'object') return false;
		const o = raw as Record<string, unknown>;
		const loc = o.location as Record<string, unknown> | undefined;
		const vec = o.vector as Record<string, unknown> | undefined;
		return (
			typeof o.definitionUri === 'string' &&
			!!loc &&
			typeof loc.slotName === 'string' &&
			!!vec &&
			typeof vec.x === 'number' &&
			typeof vec.y === 'number' &&
			typeof vec.z === 'number'
		);
	}

	onMount(() => {
		const sp = $page.url.searchParams;
		if (sp.get('lpc') !== 'applied') return;
		const key = `ot_lpc_offsets:${data.protocolId}`;
		let raw: string | null = null;
		try {
			raw = sessionStorage.getItem(key);
			if (raw) sessionStorage.removeItem(key);
		} catch {
			return;
		}
		if (!raw) return;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.every(isLpcOffset)) {
				lpcOffsets = parsed as LpcOffset[];
			}
		} catch {
			// malformed — drop silently
		}
	});

	function clearLpcOffsets() {
		lpcOffsets = [];
	}

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

	type DeckLabware = {
		id: string;
		loadName: string;
		displayName?: string | null;
		namespace?: string | null;
		location?: { slotName?: string | null; moduleId?: string | null; labwareId?: string | null };
	};
	const deckLabware: DeckLabware[] = ((a?.labware ?? []) as DeckLabware[]).filter(
		(lw) => typeof lw.location?.slotName === 'string' && lw.location.slotName.length > 0
	);
	let deckChecked = $state<Record<string, boolean>>({});
	const deckConfirmed = $derived(
		deckLabware.length === 0 || deckLabware.every((lw) => deckChecked[lw.id] === true)
	);

	type RequiredPipette = { id?: string; mount: 'left' | 'right'; pipetteName: string };
	type AttachedInstrument = {
		mount?: string;
		instrumentName?: string | null;
		instrumentModel?: string | null;
		ok?: boolean;
	};
	const requiredPipettes: RequiredPipette[] = ((a?.pipettes ?? []) as any[])
		.filter(
			(p) =>
				(p?.mount === 'left' || p?.mount === 'right') &&
				typeof p?.pipetteName === 'string' &&
				p.pipetteName.length > 0
		)
		.map((p) => ({ id: p.id, mount: p.mount, pipetteName: p.pipetteName }));

	function findAttached(mount: 'left' | 'right'): AttachedInstrument | null {
		const attached = (data.instruments as AttachedInstrument[]) ?? [];
		return attached.find((i) => i.mount === mount) ?? null;
	}

	type PipetteCheck = {
		mount: 'left' | 'right';
		needed: string;
		have: string | null;
		matches: boolean;
	};
	const pipetteChecks: PipetteCheck[] = requiredPipettes.map((rp) => {
		const attached = findAttached(rp.mount);
		const have = attached?.instrumentName ?? null;
		return {
			mount: rp.mount,
			needed: rp.pipetteName,
			have,
			matches: have === rp.pipetteName
		};
	});
	const pipettesOk = $derived(
		requiredPipettes.length === 0 ||
			(data.instrumentsReachable && pipetteChecks.every((c) => c.matches))
	);

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
		data.online &&
			!!data.protocol &&
			analysisReady &&
			valuesValid &&
			filesValid &&
			!csvBlocked &&
			deckConfirmed &&
			pipettesOk
	);

	// Strip empty-string CSV selections; send only values that are populated.
	const rtpValuesJson = $derived(JSON.stringify(values));
	const rtpFilesJson = $derived(
		JSON.stringify(
			Object.fromEntries(Object.entries(files).filter(([, v]) => v !== ''))
		)
	);
	const offsetsJson = $derived(lpcOffsets.length > 0 ? JSON.stringify(lpcOffsets) : '');
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
		<h3 class="font-semibold mb-2">Labware Position Check</h3>
		<p class="text-xs text-gray-500 mb-2">
			Optional. Jog the pipette over each slot-based labware to capture
			per-labware offsets that will be applied to the next run created from
			this protocol.
		</p>
		<a
			href={`/opentrons-clone/${data.robot._id}/protocols/${data.protocolId}/lpc`}
			class="inline-block px-3 py-1.5 border text-sm rounded hover:bg-gray-100"
		>
			Run Labware Position Check →
		</a>
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

		{#if lpcOffsets.length > 0}
			<div class="bg-blue-50 border border-blue-300 text-blue-900 rounded p-2 mb-3 text-sm flex items-start justify-between gap-2">
				<div>
					<div class="font-medium">
						{lpcOffsets.length} labware offset{lpcOffsets.length === 1 ? '' : 's'} from LPC will be applied
					</div>
					<ul class="text-xs font-mono text-blue-800 mt-1 max-h-24 overflow-y-auto">
						{#each lpcOffsets as o, i (i)}
							<li>
								slot {o.location.slotName} · {o.definitionUri} · Δ(
								{o.vector.x.toFixed(2)}, {o.vector.y.toFixed(2)}, {o.vector.z.toFixed(2)}
								)
							</li>
						{/each}
					</ul>
				</div>
				<button
					type="button"
					class="text-xs text-blue-700 hover:underline shrink-0"
					onclick={clearLpcOffsets}
				>
					clear
				</button>
			</div>
		{/if}

		<form method="POST" action="?/createRun" use:enhance>
			<input type="hidden" name="rtpValues" value={rtpValuesJson} />
			<input type="hidden" name="rtpFiles" value={rtpFilesJson} />
			<input type="hidden" name="offsets" value={offsetsJson} />

			{#if analysisReady && requiredPipettes.length > 0}
				<div class="space-y-2 mb-4">
					<div class="flex items-center justify-between">
						<h4 class="text-gray-700 font-medium text-xs">Pipettes ({requiredPipettes.length})</h4>
						{#if !data.instrumentsReachable}
							<span class="text-xs text-red-700">Cannot verify — robot offline</span>
						{:else if pipettesOk}
							<span class="text-xs text-green-700">OK — pipettes match</span>
						{:else}
							<span class="text-xs text-red-700">Mismatch — swap the pipette</span>
						{/if}
					</div>
					<ul class="border rounded divide-y">
						{#each pipetteChecks as c (c.mount)}
							<li class="flex items-start gap-2 p-2 text-xs">
								{#if !data.instrumentsReachable}
									<span class="text-red-700">⚠</span>
									<div>
										<div class="font-medium capitalize">{c.mount}</div>
										<div class="font-mono text-gray-400">
											needs {c.needed} — have ? (robot offline)
										</div>
									</div>
								{:else if c.matches}
									<span class="text-green-700">✓</span>
									<div>
										<div class="font-medium capitalize">{c.mount}</div>
										<div class="font-mono text-gray-600">
											needs {c.needed} — have {c.have}
										</div>
									</div>
								{:else}
									<span class="text-red-700">✗</span>
									<div>
										<div class="font-medium capitalize">{c.mount}</div>
										<div class="font-mono text-red-700">
											needs {c.needed} — have {c.have ?? '(empty)'}
										</div>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if analysisReady && deckLabware.length > 0}
				<div class="space-y-2 mb-4">
					<div class="flex items-center justify-between">
						<h4 class="text-gray-700 font-medium text-xs">Deck setup ({deckLabware.length})</h4>
						<button
							type="button"
							class="text-xs text-blue-600 hover:underline"
							onclick={() => {
								const next: Record<string, boolean> = {};
								for (const lw of deckLabware) next[lw.id] = true;
								deckChecked = next;
							}}
						>
							Check all
						</button>
					</div>
					<p class="text-xs text-gray-500">
						Confirm each labware is physically on the deck before creating a run.
					</p>
					<ul class="border rounded divide-y">
						{#each deckLabware as lw (lw.id)}
							<li class="flex items-start gap-2 p-2">
								<input
									id={`deck-${lw.id}`}
									type="checkbox"
									class="mt-0.5"
									checked={deckChecked[lw.id] === true}
									onchange={(e) =>
										(deckChecked[lw.id] = (e.target as HTMLInputElement).checked)}
								/>
								<label for={`deck-${lw.id}`} class="text-xs cursor-pointer">
									<div class="font-medium">
										Slot {lw.location?.slotName} — {lw.displayName ?? lw.loadName}
									</div>
									<div class="font-mono text-gray-400">{lw.loadName}</div>
								</label>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

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
