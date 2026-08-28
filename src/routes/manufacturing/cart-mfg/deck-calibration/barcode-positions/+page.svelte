<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();

	type Robot = { _id: string; name: string; ip?: string; robotSide?: string; robotModel?: string };
	type PositionSet = {
		_id: string;
		robotId: string;
		title: string;
		positionCount: number;
		positions: Array<{ slotIndex: number }>;
		isDefault: boolean;
		pipetteMount?: string;
		pipetteName?: string;
		updatedAt?: string;
	};

	let deletingId = $state<string | null>(null);
	let deleteError = $state<string | null>(null);

	function confirmDelete(s: PositionSet) {
		const taught = s.positions?.length ?? 0;
		const detail = `${s.title} (${taught} taught)${s.isDefault ? ' — currently default' : ''}`;
		return confirm(`Delete "${detail}"? This cannot be undone.`);
	}

	const robots = $derived((data.robots ?? []) as Robot[]);
	const positionSets = $derived((data.positionSets ?? []) as PositionSet[]);

	const setsByRobot = $derived.by(() => {
		const map = new Map<string, PositionSet[]>();
		for (const r of robots) map.set(r._id, []);
		for (const s of positionSets) {
			if (!map.has(s.robotId)) map.set(s.robotId, []);
			map.get(s.robotId)!.push(s);
		}
		return map;
	});

	let newSetRobotId = $state<string>('');
	let newSetTitle = $state<string>('');
	let newSetCount = $state<number>(24);
	let newSetMount = $state<'left' | 'right'>('left');
	let newSetPipetteName = $state<string>('');
	let showNewForm = $state<boolean>(false);

	function fmtTime(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}

	function progressLabel(s: PositionSet): string {
		const taught = s.positions?.length ?? 0;
		return `${taught} / ${s.positionCount} taught`;
	}
</script>

<svelte:head><title>Barcode Scan Positions</title></svelte:head>

<div class="mx-auto max-w-5xl space-y-8 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Barcode Scan Positions</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Taught deck XYZ points the gantry-mounted scanner visits during cartridge sweeps.
			</p>
		</div>
		<a href="/manufacturing/cart-mfg/deck-calibration"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)] transition-colors"
			style="color: var(--color-tron-text)">
			← Back to Deck Calibration
		</a>
	</div>

	<!-- Cartridge Scan Position Sets -->
	<section class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-5">
		<div class="mb-4 flex items-center justify-between">
			<div>
				<h2 class="text-lg font-semibold" style="color: var(--color-tron-cyan)">Cartridge Scan Position Sets</h2>
				<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
					Saved deck XYZ positions used by the gantry-mounted barcode scanner. The wax + reagent
					filling pages drive the OT-2 to these points and read each cartridge barcode automatically.
				</p>
			</div>
			<button
				type="button"
				onclick={() => { showNewForm = !showNewForm; }}
				class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 transition-colors"
			>
				{showNewForm ? 'Cancel' : '+ New Position Set'}
			</button>
		</div>

		{#if form?.error}
			<p class="mb-3 rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{form.error}</p>
		{/if}

		{#if showNewForm}
			<form
				method="POST"
				action="?/createPositionSet"
				class="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-[var(--color-tron-cyan)]/40 bg-black/20 p-4 sm:grid-cols-2 lg:grid-cols-5"
			>
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Robot</span>
					<select
						name="robotId"
						bind:value={newSetRobotId}
						required
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 text-sm"
						style="color: var(--color-tron-text)"
					>
						<option value="" disabled>Select…</option>
						{#each robots as r (r._id)}
							<option value={r._id}>{r.name}{r.robotSide ? ` (${r.robotSide})` : ''}</option>
						{/each}
					</select>
				</label>

				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Title</span>
					<input
						type="text"
						name="title"
						bind:value={newSetTitle}
						required
						placeholder="e.g. 24-cart wax tray"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>

				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Positions</span>
					<input
						type="number"
						name="positionCount"
						bind:value={newSetCount}
						min={1}
						max={96}
						required
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>

				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Pipette mount</span>
					<select
						name="pipetteMount"
						bind:value={newSetMount}
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 text-sm"
						style="color: var(--color-tron-text)"
					>
						<option value="left">left</option>
						<option value="right">right</option>
					</select>
				</label>

				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Pipette name (optional)</span>
					<input
						type="text"
						name="pipetteName"
						bind:value={newSetPipetteName}
						placeholder="auto-detect"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>

				<div class="sm:col-span-2 lg:col-span-5">
					<button
						type="submit"
						class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-2 text-sm font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 transition-colors"
					>
						Create &amp; Start Teaching →
					</button>
					<span class="ml-3 text-xs" style="color: var(--color-tron-text-secondary)">
						You'll be taken to the teach panel where you can jog the robot and save each slot's XYZ.
					</span>
				</div>
			</form>
		{/if}

		{#if deleteError}
			<p class="mb-3 rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{deleteError}</p>
		{/if}

		{#if robots.length === 0}
			<p class="rounded border border-[var(--color-tron-border)] p-3 text-xs" style="color: var(--color-tron-text-secondary)">
				No active OT-2 robots are registered. Add one under <a class="underline" href="/opentrons/devices">Opentrons → Devices</a> first.
			</p>
		{:else}
			<div class="space-y-3">
				{#each robots as r (r._id)}
					{@const sets = setsByRobot.get(r._id) ?? []}
					<div class="rounded border border-[var(--color-tron-border)] bg-black/20 p-3">
						<div class="mb-2 flex items-center justify-between">
							<div>
								<span class="text-sm font-semibold" style="color: var(--color-tron-text)">{r.name}</span>
								{#if r.robotSide}
									<span class="ml-2 text-[11px]" style="color: var(--color-tron-text-secondary)">({r.robotSide})</span>
								{/if}
								{#if r.ip}
									<span class="ml-2 font-mono text-[11px]" style="color: var(--color-tron-text-secondary)">{r.ip}</span>
								{/if}
							</div>
							<span class="text-[11px]" style="color: var(--color-tron-text-secondary)">{sets.length} set{sets.length === 1 ? '' : 's'}</span>
						</div>
						{#if sets.length === 0}
							<p class="text-xs italic" style="color: var(--color-tron-text-secondary)">No position sets — create one above.</p>
						{:else}
							<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
								{#each sets as s (s._id)}
									<div class="relative">
										<a
											href={`/manufacturing/cart-mfg/deck-calibration/scanner-positions/${s._id}`}
											class="block rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 pr-10 transition-colors hover:border-[var(--color-tron-cyan)]/50"
										>
											<div class="flex items-center justify-between gap-2">
												<span class="font-medium" style="color: var(--color-tron-text)">{s.title}</span>
												{#if s.isDefault}
													<span class="rounded bg-[var(--color-tron-cyan)]/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-tron-cyan)]">default</span>
												{/if}
											</div>
											<div class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
												{progressLabel(s)} · {s.pipetteMount ?? 'left'} mount{s.pipetteName ? ` · ${s.pipetteName}` : ''}
											</div>
											{#if s.updatedAt}
												<div class="mt-0.5 text-[10px]" style="color: var(--color-tron-text-secondary)">
													Last edit: {fmtTime(s.updatedAt)}
												</div>
											{/if}
										</a>
										<form
											method="POST"
											action={`/manufacturing/cart-mfg/deck-calibration/scanner-positions/${s._id}?/deleteSet`}
											class="absolute right-1.5 top-1.5"
											use:enhance={({ cancel }) => {
												if (!confirmDelete(s)) {
													cancel();
													return;
												}
												deletingId = s._id;
												deleteError = null;
												return async ({ result, update }) => {
													deletingId = null;
													if (result.type === 'error' || result.type === 'failure') {
														deleteError =
															(result as any)?.data?.error ??
															(result as any)?.error?.message ??
															'Failed to delete set';
													}
													await update();
													await invalidateAll();
												};
											}}
										>
											<button
												type="submit"
												title="Delete set"
												aria-label={`Delete ${s.title}`}
												disabled={deletingId === s._id}
												class="rounded border border-[var(--color-tron-border)] bg-black/40 px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:border-red-400/60 hover:text-red-300 disabled:opacity-40"
											>
												{deletingId === s._id ? '…' : '×'}
											</button>
										</form>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>
