<script lang="ts">
	let { data } = $props();

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
	<h3 class="font-semibold mb-2">Calibration (read-only)</h3>
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
