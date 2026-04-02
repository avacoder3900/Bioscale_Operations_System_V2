<script lang="ts">
	import { enhance } from '$app/forms';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface Props {
		data: {
			spus: { id: string; udi: string; particleDeviceId: string | null; status: string }[];
			criteria: { minZ: number; maxZ: number };
		};
		form: any;
	}

	let { data, form }: Props = $props();

	let selectedSpuId = $state('');
	let fetching = $state(false);
	let editingCriteria = $state(false);
	let savingCriteria = $state(false);

	const selectedSpu = $derived(data.spus.find(s => s.id === selectedSpuId));

	function formatDate(date: string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}
</script>

<div class="space-y-6">
	<h2 class="tron-text-primary text-2xl font-bold">Magnetometer Validation</h2>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,0,0,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	<TronCard>
		<div class="p-4 space-y-4">
			<h3 class="tron-text-primary text-lg font-bold">Fetch Magnetometer Results</h3>
			<p class="tron-text-muted text-sm">Run the test on the SPU first, then select it here to fetch the results.</p>

			<div>
				<label for="spu-select" class="tron-label">Select SPU</label>
				<select id="spu-select" class="tron-select w-full" style="min-height: 48px;" bind:value={selectedSpuId}>
					<option value="">Choose an SPU…</option>
					{#each data.spus as spu (spu.id)}
						<option value={spu.id}>{spu.udi} ({spu.status})</option>
					{/each}
				</select>
			</div>

			{#if selectedSpu && !selectedSpu.particleDeviceId}
				<div class="text-sm" style="color: var(--color-tron-orange);">
					⚠️ This SPU has no Particle device linked.
				</div>
			{/if}

			<form method="POST" action="?/readFromDevice" use:enhance={() => {
				fetching = true;
				return async ({ update }) => {
					fetching = false;
					await update();
				};
			}}>
				<input type="hidden" name="spuId" value={selectedSpuId} />
				<button
					type="submit"
					disabled={!selectedSpu?.particleDeviceId || fetching}
					class="w-full rounded-lg p-4 text-center font-bold text-lg transition-all cursor-pointer hover:opacity-90 active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed"
					style="background: linear-gradient(135deg, var(--color-tron-cyan), var(--color-tron-green)); color: var(--color-tron-bg-primary); min-height: 56px;"
				>
					{fetching ? '⏳ Fetching…' : '🧲 Fetch Results'}
				</button>
			</form>

			<!-- Inline Results -->
			{#if form?.success && form?.magResults}
				<div class="rounded-lg border p-4 space-y-4" style="border-color: {form.overallPassed ? 'var(--color-tron-green)' : 'var(--color-tron-red)'}; background: {form.overallPassed ? 'rgba(0,255,100,0.05)' : 'rgba(255,0,0,0.05)'};">
					<div class="flex items-center justify-between">
						<div>
							<span class="tron-text-primary font-bold">{form.spuUdi}</span>
							<span class="tron-text-muted text-xs ml-2">{formatDate(form.completedAt)}</span>
						</div>
						{#if form.overallPassed}
							<span class="rounded-full px-3 py-1 text-sm font-bold" style="color: var(--color-tron-green); background: rgba(0,255,100,0.15);">PASS</span>
						{:else}
							<span class="rounded-full px-3 py-1 text-sm font-bold" style="color: var(--color-tron-red); background: rgba(255,0,0,0.15);">FAIL</span>
						{/if}
					</div>

					{#if form.overallPassed}
						<p class="text-sm" style="color: var(--color-tron-green);">Results saved to SPU DHR.</p>
					{/if}

					{#if form.criteriaUsed}
						<div class="tron-text-muted text-xs">Criteria: Z range {form.criteriaUsed.minZ} – {form.criteriaUsed.maxZ}</div>
					{/if}

					<div class="overflow-x-auto">
						<table class="tron-table text-xs">
							<thead>
								<tr>
									<th>Well</th>
									<th>Ch A (Z)</th>
									<th>Ch B (Z)</th>
									<th>Ch C (Z)</th>
								</tr>
							</thead>
							<tbody>
								{#each form.magResults as well}
									<tr>
										<td class="font-mono font-bold">{well.well}</td>
										{#each ['A', 'B', 'C'] as ch}
											{@const z = well[`ch${ch}_Z`]}
											{@const inRange = z !== null && z !== undefined && form.criteriaUsed && z >= form.criteriaUsed.minZ && z <= form.criteriaUsed.maxZ}
											<td class="font-mono" style="color: {z === null || z === undefined ? 'var(--color-tron-text-secondary)' : inRange ? 'var(--color-tron-green)' : 'var(--color-tron-red)'};">
												{z !== null && z !== undefined ? z : '—'}
												{#if z !== null && z !== undefined}
													<span class="ml-1">{inRange ? '✓' : '✗'}</span>
												{/if}
											</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>

					{#if form.failureReasons?.length > 0}
						<div class="space-y-1">
							{#each form.failureReasons as reason}
								<div class="text-xs" style="color: var(--color-tron-red);">✗ {reason}</div>
							{/each}
						</div>
					{/if}

					<details>
						<summary class="tron-text-muted text-xs cursor-pointer hover:underline">Raw Device Output</summary>
						<pre class="mt-2 text-[10px] tron-text-muted overflow-x-auto p-2 rounded" style="background: var(--color-tron-bg-secondary); white-space: pre-wrap; word-break: break-all;">{form.rawData}</pre>
					</details>

					<a href="/validation/magnetometer/{form.sessionId}" class="text-xs underline block" style="color: var(--color-tron-cyan);">View full session →</a>
				</div>
			{/if}
		</div>
	</TronCard>

	<!-- Pass/Fail Criteria -->
	<TronCard>
		<div class="p-4">
			<div class="flex items-center justify-between">
				<h3 class="tron-text-primary font-bold">Pass/Fail Criteria (Z-axis)</h3>
				{#if !editingCriteria}
					<button type="button" onclick={() => (editingCriteria = true)} class="tron-text-muted text-xs underline">Edit</button>
				{/if}
			</div>

			{#if editingCriteria}
				<form
					method="POST"
					action="?/updateCriteria"
					use:enhance={() => {
						savingCriteria = true;
						return async ({ update }) => {
							savingCriteria = false;
							editingCriteria = false;
							await update();
						};
					}}
					class="mt-3 flex items-end gap-3"
				>
					<div class="flex-1">
						<label for="minZ" class="tron-label text-xs">Min Z</label>
						<input id="minZ" name="minZ" type="number" class="tron-input w-full" value={data.criteria.minZ} style="min-height: 44px;" />
					</div>
					<div class="flex-1">
						<label for="maxZ" class="tron-label text-xs">Max Z</label>
						<input id="maxZ" name="maxZ" type="number" class="tron-input w-full" value={data.criteria.maxZ} style="min-height: 44px;" />
					</div>
					<TronButton type="submit" variant="primary" disabled={savingCriteria} style="min-height: 44px;">
						{savingCriteria ? 'Saving…' : 'Save'}
					</TronButton>
					<button type="button" onclick={() => (editingCriteria = false)} class="tron-text-muted text-sm">Cancel</button>
				</form>
			{:else}
				<p class="tron-text-muted mt-2 text-sm">
					Z values must be between <strong class="tron-text-primary">{data.criteria.minZ}</strong> and <strong class="tron-text-primary">{data.criteria.maxZ}</strong> gauss to pass.
				</p>
				{#if form?.criteriaUpdated}
					<p class="mt-1 text-xs" style="color: var(--color-tron-green);">✓ Criteria updated</p>
				{/if}
			{/if}
		</div>
	</TronCard>
</div>
