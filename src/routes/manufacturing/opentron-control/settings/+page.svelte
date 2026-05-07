<script lang="ts">
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

<div class="mx-auto max-w-5xl space-y-8 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Manufacturing Settings</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Current values for wax filling and reagent filling. Last saved: {fmtTime(data.lastUpdatedAt)}
			</p>
		</div>
		<a href="/manufacturing/opentron-control"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)] transition-colors"
			style="color: var(--color-tron-text)">
			← Back to Opentron Control
		</a>
	</div>

	<!-- Wax Filling -->
	<section class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-5">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-lg font-semibold" style="color: var(--color-tron-cyan)">Wax Filling</h2>
			<a href="/manufacturing/wax-filling/settings"
				class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 transition-colors">
				Edit wax settings →
			</a>
		</div>

		<div class="mb-3">
			<h3 class="mb-2 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Timers</h3>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Minimum oven cure time</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.minOvenTimeMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Run duration (expected)</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.runDurationMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Remove-deck warning</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.removeDeckWarningMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Cooling warning</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.coolingWarningMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Min cooling before QC</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.minCoolingBeforeQcMin} <span class="text-xs">min</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Deck lockout</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.deckLockoutMin} <span class="text-xs">min</span></div>
				</div>
			</div>
		</div>

		<div class="mb-3">
			<h3 class="mb-2 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Temperatures</h3>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Incubator temperature</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.incubatorTempC} <span class="text-xs">°C</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Heater temperature</div>
					<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.wax.heaterTempC} <span class="text-xs">°C</span></div>
				</div>
			</div>
		</div>

		<div>
			<h3 class="mb-2 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Volumes &amp; geometry</h3>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Wax per deck</div>
					<div class="mt-1 font-mono text-base" style="color: var(--color-tron-text)">{data.wax.waxPerDeckUl} <span class="text-xs">μL</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Tube capacity</div>
					<div class="mt-1 font-mono text-base" style="color: var(--color-tron-text)">{data.wax.tubeCapacityUl} <span class="text-xs">μL</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Wax per cartridge</div>
					<div class="mt-1 font-mono text-base" style="color: var(--color-tron-text)">{data.wax.waxPerCartridgeUl} <span class="text-xs">μL</span></div>
				</div>
				<div class="rounded border border-[var(--color-tron-border)] p-3">
					<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Cartridges per column</div>
					<div class="mt-1 font-mono text-base" style="color: var(--color-tron-text)">{data.wax.cartridgesPerColumn}</div>
				</div>
			</div>
		</div>
	</section>

	<!-- Reagent Filling -->
	<section class="rounded-lg border border-purple-500/30 bg-purple-900/5 p-5">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-lg font-semibold text-purple-300">Reagent Filling</h2>
			<a href="/manufacturing/reagent-filling/settings"
				class="rounded border border-purple-500/50 bg-purple-900/10 px-3 py-1.5 text-xs font-medium text-purple-300 hover:bg-purple-900/20 transition-colors">
				Edit reagent settings →
			</a>
		</div>

		<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<div class="rounded border border-[var(--color-tron-border)] p-3">
				<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Minimum cooling time</div>
				<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.reagent.minCoolingTimeMin} <span class="text-xs">min</span></div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-3">
				<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Fill time per cartridge</div>
				<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.reagent.fillTimePerCartridgeMin} <span class="text-xs">min</span></div>
			</div>
			<div class="rounded border border-[var(--color-tron-border)] p-3">
				<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Max time before seal</div>
				<div class="mt-1 font-mono text-lg" style="color: var(--color-tron-text)">{data.reagent.maxTimeBeforeSealMin} <span class="text-xs">min</span></div>
			</div>
		</div>
	</section>

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
									<a
										href={`/manufacturing/opentron-control/settings/scanner-positions/${s._id}`}
										class="block rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 transition-colors hover:border-[var(--color-tron-cyan)]/50"
									>
										<div class="flex items-center justify-between">
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
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>
