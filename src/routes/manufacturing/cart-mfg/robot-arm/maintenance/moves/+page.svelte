<script lang="ts">
	/**
	 * Maintenance → Movement Log (2026-11-06): every command BIMS sent that
	 * moved the arm, per servo, newest first, with how many times each servo
	 * moved and turned back in the window (shapes in $lib/robot-arm/move-log).
	 *
	 * Opentrons rows (2026-11-06): every command the arm line's OT-2 ran, with
	 * the robot's own start, end and seconds, on the same timeline as the arm;
	 * Timing sets the two machines side by side ($lib/robot-arm/ot2-move-log).
	 */
	import { DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';
	import { kindTitle } from '$lib/robot-arm/move-log';

	let { data } = $props();

	let logHidden = $state(false);

	const BASE = '/manufacturing/cart-mfg/robot-arm/maintenance/moves';
	const windows = [
		{ minutes: 60, title: 'Last Hour' },
		{ minutes: 1440, title: 'Last 24 Hours' },
		{ minutes: 10080, title: 'Last 7 Days' },
		{ minutes: 0, title: 'All' }
	];
	const devices: { device: 'arm' | 'ot2' | null; title: string }[] = [
		{ device: null, title: 'Both' },
		{ device: 'arm', title: 'Robot Arm' },
		{ device: 'ot2', title: 'Opentrons' }
	];
	const servos = [1, 2, 3, 4, 5, 6];

	const jointTitle = (sid: number) =>
		(DEFAULT_JOINT_NAMES[sid - 1] ?? '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

	function href(minutes: number, servo: number | null, device: string | null = data.device): string {
		const q = new URLSearchParams({ minutes: String(minutes) });
		if (servo) q.set('servo', String(servo));
		else if (device) q.set('device', device);
		return `${BASE}?${q}`;
	}

	function when(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime())
			? ''
			: d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function ms(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '' : `.${String(d.getMilliseconds()).padStart(3, '0')}`;
	}

	const secs = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
	const took = (m: { endAt?: string | null; durationMs: number | null }) => (m.endAt && m.durationMs != null ? `${secs(m.durationMs / 1000)} s` : '');
	const deviceTitle = (m: { device?: string; robot?: { name?: string } | null }) =>
		m.device === 'ot2' ? `Opentrons${m.robot?.name ? ` ${m.robot.name.replace(/^.*?([A-Z]\d{2})$/, '$1')}` : ''}` : 'Robot Arm';

	const armTiming = $derived(data.timing.filter((t) => t.device === 'arm'));
	const ot2Timing = $derived(data.timing.filter((t) => t.device === 'ot2'));
	const total = (rows: { totalS: number }[]) => rows.reduce((s, t) => s + t.totalS, 0);

	const pill = 'rounded border px-2 py-0.5 text-xs transition-colors';
	const on = `${pill} border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]`;
	const off = `${pill} border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]`;
</script>

<div class="mx-auto max-w-6xl space-y-4 p-4">
	<div class="flex items-center justify-between">
		<h1 class="text-base font-semibold" style="color: var(--color-tron-cyan)">Movement Log</h1>
		<a
			href="/manufacturing/cart-mfg/robot-arm/maintenance"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← Maintenance
		</a>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		{#each windows as w (w.minutes)}
			<a href={href(w.minutes, data.servo)} class={data.minutes === w.minutes ? on : off}>{w.title}</a>
		{/each}
		<span class="mx-1 h-4 border-l border-[var(--color-tron-border)]"></span>
		{#each devices as d (d.title)}
			<a href={href(data.minutes, null, d.device)} class={!data.servo && data.device === d.device ? on : off}>{d.title}</a>
		{/each}
		<span class="mx-1 h-4 border-l border-[var(--color-tron-border)]"></span>
		{#each servos as s (s)}
			<a href={href(data.minutes, s)} class={data.servo === s ? on : off}>Servo {s}</a>
		{/each}
	</div>

	{#if data.ot2?.error}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">Opentrons Not Read: {data.ot2.error}</div>
	{:else if data.ot2?.pending && data.ot2.logged > 0}
		<p class="text-xs" style="color: var(--color-tron-text-secondary)">More Opentrons Commands Load On Refresh</p>
	{/if}

	{#if data.movesError}
		<div class="rounded border border-red-500/40 bg-red-900/10 p-3 text-sm text-red-300">{data.movesError}</div>
	{:else}
		{#if data.timing.length}
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<h2 class="mb-2 text-sm font-semibold" style="color: var(--color-tron-cyan)">Timing</h2>
				<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
					{#each [{ title: 'Robot Arm', rows: armTiming }, { title: 'Opentrons', rows: ot2Timing }] as g (g.title)}
						<div>
							<div class="mb-1 flex items-baseline justify-between text-xs">
								<span class="font-semibold" style="color: var(--color-tron-text)">{g.title}</span>
								<span class="font-mono" style="color: var(--color-tron-text-secondary)">{secs(total(g.rows))} s</span>
							</div>
							{#if !g.rows.length}
								<p class="text-xs" style="color: var(--color-tron-text-secondary)">Nothing Timed</p>
							{:else}
								<table class="w-full text-left text-xs">
									<thead style="color: var(--color-tron-text-secondary)">
										<tr><th class="py-1 pr-3">Type</th><th class="pr-3">Count</th><th class="pr-3">Total</th><th class="pr-3">Average</th><th class="pr-3">Longest</th></tr>
									</thead>
									<tbody>
										{#each g.rows as t (t.kind)}
											<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
												<td class="py-1 pr-3">{kindTitle(t.kind)}</td>
												<td class="pr-3 font-mono">{t.count}</td>
												<td class="pr-3 font-mono">{secs(t.totalS)} s</td>
												<td class="pr-3 font-mono">{secs(t.avgS)} s</td>
												<td class="pr-3 font-mono">{secs(t.maxS)} s</td>
											</tr>
										{/each}
									</tbody>
								</table>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if data.device !== 'ot2'}
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<table class="w-full text-left text-xs">
					<thead style="color: var(--color-tron-text-secondary)">
						<tr><th class="py-1 pr-3">Servo</th><th class="pr-3">Joint</th><th class="pr-3">Moves</th><th class="pr-3">Direction Changes</th></tr>
					</thead>
					<tbody>
						{#each data.summary as s (s.servo)}
							<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
								<td class="py-1 pr-3">{s.servo}</td>
								<td class="pr-3">{jointTitle(s.servo)}</td>
								<td class="pr-3 font-mono">{s.moves}</td>
								<td class="pr-3 font-mono">{s.reversals}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}

		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<div class="flex items-center justify-between gap-2">
				<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Movement Log</h3>
				<button
					type="button"
					onclick={() => (logHidden = !logHidden)}
					class="rounded border px-2 py-0.5 text-xs"
					style="border-color: var(--color-tron-cyan); color: var(--color-tron-cyan)"
					aria-expanded={!logHidden}
				>
					{logHidden ? 'Show' : 'Hide'}
				</button>
			</div>
			{#if !logHidden}
				{#if !data.moves.length}
					<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">No Movements Logged</p>
				{:else}
					{#if data.capped}
						<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">Newest {data.limit}</p>
					{/if}
					<table class="mt-2 w-full text-left text-xs">
						<thead style="color: var(--color-tron-text-secondary)">
							<tr>
								<th class="py-1 pr-3">When</th><th class="pr-3">Device</th><th class="pr-3">Type</th><th class="pr-3">Movement</th><th class="pr-3">Took</th><th class="pr-3">Result</th><th class="pr-3">From</th><th class="pr-3">By</th>
							</tr>
						</thead>
						<tbody>
							{#each data.moves as m (m._id)}
								<tr class="border-t border-[var(--color-tron-border)]" style="color: var(--color-tron-text)">
									<td class="whitespace-nowrap py-1 pr-3" style="color: var(--color-tron-text-secondary)">{when(m.at)}<span class="opacity-60">{ms(m.at)}</span></td>
									<td class="whitespace-nowrap pr-3" style={m.device === 'ot2' ? 'color: var(--color-tron-cyan)' : ''}>{deviceTitle(m)}</td>
									<td class="whitespace-nowrap pr-3">{kindTitle(m.kind)}</td>
									<td class="pr-3 font-mono">{m.line}</td>
									<td class="whitespace-nowrap pr-3 font-mono">{took(m)}</td>
									<td class="pr-3">
										{#if m.ok}
											<span class="text-green-300">{m.device === 'ot2' ? 'Done' : 'Sent'}</span>
										{:else}
											<span class="text-red-300">Failed</span>
											<span class="ml-1" style="color: var(--color-tron-text-secondary)">{m.error}</span>
										{/if}
									</td>
									<td class="whitespace-nowrap pr-3" style="color: var(--color-tron-text-secondary)">{m.from ?? ''}</td>
									<td class="whitespace-nowrap pr-3">{m.movedBy?.username ?? ''}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			{/if}
		</section>
	{/if}
</div>
