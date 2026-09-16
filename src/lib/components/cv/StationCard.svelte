<script lang="ts">
	/**
	 * Tablet station card — the roaming operator's entry point.
	 *
	 * The desktop table's only action is a small "details →" link, which is both
	 * untappable and the wrong destination: what an operator walking up with a
	 * tablet actually wants is "start capturing on THIS station".
	 *
	 * The availability rule deliberately mirrors the station <select> in
	 * /capture so the two pickers cannot drift: a station is unavailable when it
	 * is offline, or held by ANOTHER operator. Your own lock stays selectable so
	 * you can resume after the tablet slept.
	 */
	interface Operator {
		_id?: string | null;
		username: string;
		since: string | null;
	}

	interface Station {
		id: string;
		name: string;
		location: string | null;
		hostname: string;
		status: string;
		lastSeenAt: string | null;
		capabilities: { camera?: boolean; scanner?: boolean };
		health: { cameraOk: boolean; scannerOk: boolean } | null;
		currentOperator: Operator | null;
	}

	let {
		station,
		currentUserId = null
	}: { station: Station; currentUserId?: string | null } = $props();

	const online = $derived(station.status === 'online' || station.status === 'degraded');
	const heldByOther = $derived(
		!!station.currentOperator?._id && station.currentOperator._id !== currentUserId
	);
	const heldByMe = $derived(
		!!station.currentOperator?._id && station.currentOperator._id === currentUserId
	);
	const unavailable = $derived(!online || heldByOther);

	function statusColor(status: string): string {
		if (status === 'online') return 'var(--color-tron-green,#39ff14)';
		if (status === 'degraded') return 'var(--color-tron-yellow,#facc15)';
		return 'var(--color-tron-red,#ff3366)';
	}

	function relativeTime(iso: string | null): string {
		if (!iso) return '—';
		const ms = Date.now() - new Date(iso).getTime();
		if (ms < 0) return 'in the future';
		if (ms < 5_000) return 'just now';
		if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
		return `${Math.floor(ms / 86_400_000)} d ago`;
	}
</script>

<div
	class="flex flex-col gap-3 rounded-lg border bg-[var(--color-tron-bg-secondary)] p-4"
	style="border-color:{unavailable ? 'var(--color-tron-border)' : statusColor(station.status)}"
>
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0">
			<div class="truncate text-lg font-semibold text-[var(--color-tron-cyan)]">{station.name}</div>
			{#if station.location}
				<div class="truncate text-sm text-[var(--color-tron-text-secondary)]">{station.location}</div>
			{/if}
			<div class="truncate font-mono text-xs text-[var(--color-tron-text-secondary)]">{station.hostname}</div>
		</div>
		<span class="flex shrink-0 items-center gap-2">
			<span class="inline-block h-3 w-3 rounded-full" style="background:{statusColor(station.status)}"></span>
			<span class="text-sm" style="color:{statusColor(station.status)}">{station.status}</span>
		</span>
	</div>

	<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--color-tron-text-secondary)]">
		<span>
			Camera
			{#if station.capabilities.camera}
				<span style="color:{station.health?.cameraOk ? statusColor('online') : statusColor('offline')}">
					{station.health?.cameraOk ? '✓' : '✗'}
				</span>
			{:else}
				—
			{/if}
		</span>
		<span>
			Scanner
			{#if station.capabilities.scanner}
				<span style="color:{station.health?.scannerOk ? statusColor('online') : statusColor('offline')}">
					{station.health?.scannerOk ? '✓' : '✗'}
				</span>
			{:else}
				—
			{/if}
		</span>
		<span title={station.lastSeenAt ?? ''}>Seen {relativeTime(station.lastSeenAt)}</span>
	</div>

	{#if station.currentOperator}
		<div class="text-sm {heldByOther ? 'text-[var(--color-tron-yellow,#facc15)]' : ''}">
			{#if heldByMe}
				<span class="text-[var(--color-tron-cyan)]">Your session</span>
				<span class="text-[var(--color-tron-text-secondary)]">
					· since {relativeTime(station.currentOperator.since)}
				</span>
			{:else}
				In use by {station.currentOperator.username} · since {relativeTime(station.currentOperator.since)}
			{/if}
		</div>
	{/if}

	<div class="mt-auto flex flex-col gap-2">
		{#if unavailable}
			<span
				class="tron-btn-secondary w-full cursor-not-allowed opacity-50"
				title={heldByOther ? 'Another operator holds this station' : 'Station is not online'}
			>
				{heldByOther ? 'In use' : 'Offline'}
			</span>
		{:else}
			<a href={`/capture?station=${encodeURIComponent(station.id)}`} class="tron-btn-primary w-full">
				{heldByMe ? 'Resume capture →' : 'Open capture →'}
			</a>
		{/if}
		<a href={`/cv/stations/${station.id}`} class="tron-btn-secondary w-full">Details</a>
	</div>
</div>
