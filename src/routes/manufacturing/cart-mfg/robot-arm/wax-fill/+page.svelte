<script lang="ts">
	let { data, form } = $props();

	const phaseColors: Record<string, string> = {
		created: 'text-gray-300',
		arm_loading: 'text-yellow-400',
		loaded: 'text-cyan-300',
		ot2_filling: 'text-yellow-400',
		filled: 'text-cyan-300',
		arm_unloading: 'text-yellow-400',
		complete: 'text-green-400',
		failed: 'text-red-400',
		aborted: 'text-gray-400'
	};

	function fmt(iso: string | null | undefined): string {
		return iso ? new Date(iso).toLocaleString() : '—';
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">
				Arm Wax Fill — single cartridge
			</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Robot arm loads one Gen7 cartridge into the OT-2 nest, wax gates are filled, arm
				unloads. Every handoff is verified before the next machine may move.
			</p>
		</div>
		<a
			href="/manufacturing/cart-mfg/robot-arm"
			class="text-xs transition-colors hover:text-[var(--color-tron-cyan)]"
			style="color: var(--color-tron-text-secondary)"
		>
			← robot arm
		</a>
	</div>

	{#if form?.error}
		<div class="rounded border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-400">
			{form.error}
		</div>
	{/if}

	<!-- Create run -->
	<section
		class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		<h2
			class="mb-3 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			New run
		</h2>
		<form method="POST" action="?/create" class="space-y-4">
			<div class="grid gap-4 sm:grid-cols-2">
				<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
					Cartridge barcode
					<input
						name="cartridgeId"
						required
						autocomplete="off"
						placeholder="scan cartridge…"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 p-2 font-mono text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
					OT-2 robot
					<select
						name="robotId"
						required
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-sm"
						style="color: var(--color-tron-text)"
					>
						{#each data.robots as robot (robot._id)}
							<option value={robot._id}>{robot.name} ({robot.ip})</option>
						{/each}
					</select>
				</label>
			</div>

			<div class="grid gap-4 sm:grid-cols-4">
				{#each [4, 3, 2, 1] as gate (gate)}
					<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
						Gate {gate} (µL)
						<input
							name={`volGate${gate}`}
							type="number"
							step="0.05"
							min="0.1"
							max="20"
							value="1.6"
							class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-sm"
							style="color: var(--color-tron-text)"
						/>
					</label>
				{/each}
			</div>

			<div class="grid gap-4 sm:grid-cols-4">
				<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
					Nest slot
					<input
						name="nestSlot"
						value="1"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
					Wax tube well
					<input
						name="waxTubeWell"
						value="A1"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<label class="block text-sm" style="color: var(--color-tron-text-secondary)">
					Aspirate remainder (µL)
					<input
						name="aspirateRemainder"
						type="number"
						step="0.5"
						min="0"
						max="18"
						value="11.5"
						class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-sm"
						style="color: var(--color-tron-text)"
					/>
				</label>
				<div class="flex flex-col justify-end gap-1 text-sm" style="color: var(--color-tron-text-secondary)">
					{#each [['channelA', 'Channel A'], ['channelB', 'Channel B'], ['channelC', 'Channel C']] as [name, label] (name)}
						<label class="flex items-center gap-2">
							<input type="checkbox" {name} checked /> {label}
						</label>
					{/each}
				</div>
			</div>

			<div class="flex items-center gap-6 text-sm" style="color: var(--color-tron-text-secondary)">
				<label class="flex items-center gap-2">
					<input type="checkbox" name="dryRun" /> Dry run (no wax)
				</label>
				<label class="flex items-center gap-2">
					<input type="checkbox" name="createMissing" /> Create cartridge if missing (test)
				</label>
			</div>

			<button
				type="submit"
				class="rounded border border-[var(--color-tron-cyan)] px-4 py-2 text-sm font-bold transition-colors hover:bg-[var(--color-tron-cyan)]/10"
				style="color: var(--color-tron-cyan)"
			>
				Create run
			</button>
		</form>
	</section>

	<!-- Recent runs -->
	<section>
		<h2
			class="mb-2 text-sm font-bold uppercase tracking-wider"
			style="color: var(--color-tron-text-secondary)"
		>
			Recent runs
		</h2>
		{#if data.runs.length === 0}
			<p class="text-sm" style="color: var(--color-tron-text-secondary)">No runs yet.</p>
		{:else}
			<div
				class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]"
			>
				<table class="w-full text-left text-sm">
					<thead>
						<tr
							class="border-b border-[var(--color-tron-border)] text-xs uppercase"
							style="color: var(--color-tron-text-secondary)"
						>
							<th class="p-2">Cartridge</th>
							<th class="p-2">Phase</th>
							<th class="p-2">Created</th>
							<th class="p-2">By</th>
							<th class="p-2">Error</th>
						</tr>
					</thead>
					<tbody>
						{#each data.runs as run (run._id)}
							<tr
								class="border-b border-[var(--color-tron-border)]/40 last:border-0 hover:bg-white/5"
							>
								<td class="p-2 font-mono text-xs">
									<a
										href={`/manufacturing/cart-mfg/robot-arm/wax-fill/${run._id}`}
										class="hover:text-[var(--color-tron-cyan)]"
										style="color: var(--color-tron-text)"
									>
										{run.cartridgeId}
									</a>
								</td>
								<td class={`p-2 ${phaseColors[run.phase] ?? ''}`}>{run.phase}</td>
								<td class="p-2" style="color: var(--color-tron-text-secondary)">
									{fmt(run.createdAt)}
								</td>
								<td class="p-2" style="color: var(--color-tron-text-secondary)">
									{run.triggeredBy?.username ?? '—'}
								</td>
								<td class="p-2 text-xs text-red-400">{run.error ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
