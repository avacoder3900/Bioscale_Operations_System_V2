<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();

	const STALE_DAYS = 7;

	function daysSince(iso: string | null | undefined): number | null {
		if (!iso) return null;
		const ms = Date.now() - new Date(iso).getTime();
		return Math.floor(ms / 86_400_000);
	}

	function fmt(value: unknown): string {
		if (value === null || value === undefined) return '—';
		if (typeof value === 'number') return value.toFixed(2);
		return String(value);
	}

	const deckLast = data.calibrationStatus?.deckCalibration?.data?.lastModified ?? null;
	const deckStaleDays = daysSince(deckLast);
	const deckStale = deckStaleDays !== null && deckStaleDays > STALE_DAYS;
	const anyCalStale =
		deckStale ||
		data.pipetteOffsets.some((o: any) => (daysSince(o.lastModified) ?? 0) > STALE_DAYS) ||
		data.tipLengths.some((t: any) => (daysSince(t.lastModified) ?? 0) > STALE_DAYS);
</script>

<div class="mb-4">
	<a href="/opentrons-clone" class="text-sm text-blue-600 hover:underline">← All robots</a>
</div>

<header class="bg-white border rounded-lg p-4 mb-4">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-xl font-semibold">{data.robot.name}</h2>
			<p class="text-xs text-gray-500 mt-1">{data.robot.ip}{data.robot.port ? `:${data.robot.port}` : ''}</p>
		</div>
		<span class="text-xs px-2 py-0.5 rounded-full {data.online ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">
			{data.online ? 'Online' : 'Offline'}
		</span>
	</div>
	{#if data.health}
		<dl class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mt-3">
			<div><dt class="text-gray-400">API</dt><dd>{data.health.api_version ?? '—'}</dd></div>
			<div><dt class="text-gray-400">Firmware</dt><dd>{data.health.fw_version ?? '—'}</dd></div>
			<div><dt class="text-gray-400">System</dt><dd>{data.health.system_version ?? '—'}</dd></div>
			<div><dt class="text-gray-400">Serial</dt><dd>{data.health.robot_serial ?? '—'}</dd></div>
		</dl>
	{/if}
</header>

{#if anyCalStale}
	<div class="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-3 mb-4 text-sm">
		<strong>Calibration is stale</strong> (over {STALE_DAYS} days old).
		Open the Opentrons App on the lab Mac to re-run the calibration wizards — BIMS is read-only for calibration.
	</div>
{/if}

{#if form?.error}
	<div class="bg-red-50 border border-red-300 text-red-900 rounded p-2 mb-3 text-sm">{form.error}</div>
{:else if form?.success}
	<div class="bg-green-50 border border-green-300 text-green-900 rounded p-2 mb-3 text-sm">{form.message ?? 'OK'}</div>
{/if}

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Controls</h3>
	<div class="flex flex-wrap gap-2 items-center text-sm">
		<form
			method="POST"
			action="?/home"
			use:enhance={() => async ({ result }) => {
				if (result.type === 'success') await invalidateAll();
			}}
			class="flex items-center gap-1"
		>
			<input type="hidden" name="target" value="robot" />
			<button
				type="submit"
				disabled={!data.online}
				class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
				onclick={(e) => {
					if (!confirm('Home all axes? Robot will move.')) e.preventDefault();
				}}
			>
				Home robot
			</button>
		</form>

		<form
			method="POST"
			action="?/home"
			use:enhance
			class="flex items-center gap-1"
		>
			<input type="hidden" name="target" value="pipette" />
			<input type="hidden" name="mount" value="left" />
			<button
				type="submit"
				disabled={!data.online}
				class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50 text-xs"
				onclick={(e) => { if (!confirm('Home left pipette? It will move.')) e.preventDefault(); }}
			>
				Home left pipette
			</button>
		</form>

		<form method="POST" action="?/home" use:enhance class="flex items-center gap-1">
			<input type="hidden" name="target" value="pipette" />
			<input type="hidden" name="mount" value="right" />
			<button
				type="submit"
				disabled={!data.online}
				class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50 text-xs"
				onclick={(e) => { if (!confirm('Home right pipette? It will move.')) e.preventDefault(); }}
			>
				Home right pipette
			</button>
		</form>

		<form
			method="POST"
			action="?/lights"
			use:enhance={() => async ({ result }) => {
				if (result.type === 'success') await invalidateAll();
			}}
			class="flex items-center gap-1"
		>
			<input type="hidden" name="on" value={data.lightsOn ? 'false' : 'true'} />
			<button
				type="submit"
				disabled={!data.online}
				class="px-3 py-1.5 {data.lightsOn ? 'bg-yellow-100 hover:bg-yellow-200' : 'bg-gray-100 hover:bg-gray-200'} rounded disabled:opacity-50"
			>
				{data.lightsOn ? 'Lights on' : 'Lights off'}
			</button>
		</form>

		<form method="POST" action="?/identify" use:enhance class="flex items-center gap-1">
			<input type="hidden" name="seconds" value="10" />
			<button
				type="submit"
				disabled={!data.online}
				class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
				title="Blink lights for 10s — useful to locate this robot among several"
			>
				Identify (blink 10s)
			</button>
		</form>
	</div>
	<p class="text-xs text-gray-500 mt-2">
		Homing moves physical hardware. Make sure no labware is being touched and the deck is safe.
	</p>
</section>

<div class="flex flex-wrap gap-2 mb-4 text-sm">
	<a href={`/opentrons-clone/${data.robot._id}/protocols`} class="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded">Protocols →</a>
	<a href={`/opentrons-clone/${data.robot._id}/runs`} class="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded">Runs →</a>
	<a href={`/opentrons-clone/${data.robot._id}/labware`} class="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded">Labware →</a>
	<a href={`/opentrons-clone/${data.robot._id}/settings`} class="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded">Settings →</a>
	<a href={`/opentrons-clone/${data.robot._id}/data-files`} class="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded">Data files →</a>
</div>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Server logs</h3>
	<p class="text-xs text-gray-500 mb-2">Download raw log files from the robot.</p>
	<div class="flex flex-wrap gap-2 text-sm">
		{#each ['api.log', 'server.log', 'serial.log', 'update_server.log'] as log (log)}
			<a
				href={`/api/opentrons-clone/robots/${data.robot._id}/logs/${log}?records=5000`}
				target="_blank"
				rel="noopener"
				class="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-xs font-mono"
			>
				{log}
			</a>
		{/each}
	</div>
</section>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Instruments</h3>
	{#if data.instruments.length === 0}
		<p class="text-sm text-gray-500">No instruments attached.</p>
	{:else}
		<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
			{#each data.instruments as inst (inst.serialNumber)}
				<div class="border rounded p-3 text-sm">
					<div class="flex items-center justify-between">
						<span class="font-medium capitalize">{inst.mount} mount</span>
						<span class="text-xs px-1.5 py-0.5 rounded {inst.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">
							{inst.ok ? 'OK' : 'Error'}
						</span>
					</div>
					<dl class="text-xs text-gray-600 mt-1 space-y-0.5">
						<div><dt class="inline text-gray-400">Name:</dt> <dd class="inline">{inst.instrumentName ?? '—'}</dd></div>
						<div><dt class="inline text-gray-400">Model:</dt> <dd class="inline">{inst.instrumentModel ?? '—'}</dd></div>
						<div><dt class="inline text-gray-400">Serial:</dt> <dd class="inline font-mono">{inst.serialNumber ?? '—'}</dd></div>
						{#if inst.data}
							<div><dt class="inline text-gray-400">Channels:</dt> <dd class="inline">{inst.data.channels}</dd></div>
							<div><dt class="inline text-gray-400">Volume:</dt> <dd class="inline">{fmt(inst.data.min_volume)}–{fmt(inst.data.max_volume)} µL</dd></div>
						{/if}
					</dl>
				</div>
			{/each}
		</div>
	{/if}
</section>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Modules</h3>
	{#if data.modules.length === 0}
		<p class="text-sm text-gray-500">No modules attached.</p>
	{:else}
		<ul class="text-sm space-y-1">
			{#each data.modules as mod (mod.id)}
				<li>{mod.moduleType ?? mod.moduleModel ?? 'Module'} — <span class="text-gray-500">{mod.id}</span></li>
			{/each}
		</ul>
	{/if}
</section>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Calibration &amp; Wizards</h3>

	<div class="bg-blue-50 border border-blue-200 text-blue-900 rounded p-3 mb-3 text-xs">
		<strong class="block mb-1">How calibration works in BIMS</strong>
		<p class="mb-2">
			All calibration data is stored <em>on the robot itself</em> — not in BIMS.
			This page reads the current values live from the robot and displays them below.
			Whatever you see here is what the robot uses internally during every run,
			regardless of whether the run was started from BIMS or the Opentrons desktop App.
			Nothing is copied or duplicated; both tools are just windows into the robot's own records.
		</p>
		<p class="mb-2">
			<strong>To change a calibration</strong> (pipette offset, tip length, or deck calibration),
			open the <strong>Opentrons desktop App</strong> on the lab Mac and run the relevant wizard.
			Once the wizard completes, the new value is active on the robot immediately.
			Refresh this page to see it update here — every future run from BIMS automatically uses it.
		</p>
		<p class="mb-0">
			<strong>Per-run labware offsets</strong> (LPC) <em>are</em> in BIMS —
			use the "Run Labware Position Check" button on a protocol page to collect offsets for a specific run.
			Those are different from the robot-wide calibrations shown below.
		</p>
	</div>

	<div class="text-sm space-y-3">
		<div>
			<h4 class="font-medium text-gray-700 mb-1">Deck</h4>
			{#if data.calibrationStatus?.deckCalibration}
				<dl class="text-xs grid grid-cols-3 gap-1">
					<div><dt class="text-gray-400">Status</dt><dd>{data.calibrationStatus.deckCalibration.status ?? '—'}</dd></div>
					<div><dt class="text-gray-400">Last modified</dt><dd>{deckLast ? new Date(deckLast).toLocaleDateString() : '—'}</dd></div>
					<div><dt class="text-gray-400">Age</dt><dd class={deckStale ? 'text-amber-700' : ''}>{deckStaleDays ?? '—'} d</dd></div>
				</dl>
			{:else}
				<p class="text-gray-500 text-xs">No deck calibration data.</p>
			{/if}
		</div>

		<div>
			<h4 class="font-medium text-gray-700 mb-1">Pipette offsets</h4>
			{#if data.pipetteOffsets.length === 0}
				<p class="text-gray-500 text-xs">No pipette offsets on file.</p>
			{:else}
				<table class="text-xs w-full">
					<thead class="text-gray-400 text-left">
						<tr><th>Mount</th><th>Pipette</th><th>Offset (x/y/z)</th><th>Age</th></tr>
					</thead>
					<tbody>
						{#each data.pipetteOffsets as po (po.id)}
							{@const age = daysSince(po.lastModified)}
							<tr class="border-t">
								<td class="py-1 capitalize">{po.mount}</td>
								<td class="font-mono">{po.pipette}</td>
								<td class="font-mono">{po.offset?.map((n: number) => n.toFixed(2)).join(' / ') ?? '—'}</td>
								<td class={age !== null && age > STALE_DAYS ? 'text-amber-700' : ''}>{age ?? '—'} d</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>

		<div>
			<h4 class="font-medium text-gray-700 mb-1">Tip length</h4>
			{#if data.tipLengths.length === 0}
				<p class="text-gray-500 text-xs">No tip length calibrations on file.</p>
			{:else}
				<table class="text-xs w-full">
					<thead class="text-gray-400 text-left">
						<tr><th>Pipette</th><th>Length (mm)</th><th>Age</th></tr>
					</thead>
					<tbody>
						{#each data.tipLengths as tl (tl.id)}
							{@const age = daysSince(tl.lastModified)}
							<tr class="border-t">
								<td class="font-mono">{tl.pipette}</td>
								<td class="font-mono">{fmt(tl.tipLength)}</td>
								<td class={age !== null && age > STALE_DAYS ? 'text-amber-700' : ''}>{age ?? '—'} d</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</div>
</section>
