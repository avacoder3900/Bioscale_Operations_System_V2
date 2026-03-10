<script lang="ts">
	import { enhance } from '$app/forms';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface Props {
		data: {
			spus: { id: string; udi: string; particleDeviceId: string | null; status: string }[];
			recentSessions: {
				id: string;
				status: string;
				overallPassed: boolean | null;
				spuUdi: string | null;
				startedAt: string | null;
				completedAt: string | null;
				createdAt: string;
				username: string | null;
			}[];
			stats: { total: number; passed: number; failed: number };
			criteria: { minZ: number; maxZ: number };
		};
		form: any;
	}

	let { data, form }: Props = $props();

	let selectedSpuId = $state('');
	let reading = $state(false);
	let editingCriteria = $state(false);
	let savingCriteria = $state(false);

	// Filter out in-progress sessions from display
	const completedSessions = $derived(
		data.recentSessions.filter(s => s.status !== 'running' && s.status !== 'in_progress')
	);

	function resultBadge(passed: boolean | null) {
		if (passed === true) return { text: 'PASS', color: 'var(--color-tron-green)' };
		if (passed === false) return { text: 'FAIL', color: 'var(--color-tron-red)' };
		return { text: 'Pending', color: 'var(--color-tron-text-secondary)' };
	}
</script>

<div class="space-y-6">
	<h2 class="tron-text-primary text-2xl font-bold">Magnetometer Validation</h2>

	<!-- Error display -->
	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,0,0,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	<!-- Stats -->
	<div class="grid grid-cols-3 gap-3">
		<TronCard>
			<div class="p-4 text-center">
				<div class="tron-text-muted text-xs uppercase">Total Tests</div>
				<div class="tron-text-primary mt-1 text-2xl font-bold">{data.stats.total}</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="p-4 text-center">
				<div class="text-xs uppercase" style="color: var(--color-tron-green);">Passed</div>
				<div class="mt-1 text-2xl font-bold" style="color: var(--color-tron-green);">{data.stats.passed}</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="p-4 text-center">
				<div class="text-xs uppercase" style="color: var(--color-tron-red);">Failed</div>
				<div class="mt-1 text-2xl font-bold" style="color: var(--color-tron-red);">{data.stats.failed}</div>
			</div>
		</TronCard>
	</div>

	<!-- Read Results from Device -->
	<TronCard>
		<div class="p-4 space-y-4">
			<h3 class="tron-text-primary text-lg font-bold">Read Results from Device</h3>

			<div>
				<label for="spu-select" class="tron-label">Select SPU</label>
				<select id="spu-select" class="tron-select w-full" style="min-height: 48px;" bind:value={selectedSpuId}>
					<option value="">Choose an SPU…</option>
					{#each data.spus as spu (spu.id)}
						<option value={spu.id}>{spu.udi} ({spu.status})</option>
					{/each}
				</select>
			</div>

			<form
				method="POST"
				action="?/readFromDevice"
				use:enhance={() => {
					reading = true;
					return async ({ update }) => {
						reading = false;
						await update();
					};
				}}
			>
				<input type="hidden" name="spuId" value={selectedSpuId} />
				<TronButton type="submit" variant="primary" disabled={!selectedSpuId || reading} style="min-height: 48px; width: 100%;">
					{reading ? 'Reading…' : '📖 Read Results from Device'}
				</TronButton>
			</form>
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

	<!-- Recent Sessions -->
	<TronCard>
		<div class="p-4">
			<h3 class="tron-text-primary mb-3 font-bold">Recent Tests</h3>
			{#if completedSessions.length === 0}
				<p class="tron-text-muted text-sm">No tests recorded yet.</p>
			{:else}
				<div class="space-y-2">
					{#each completedSessions as session (session.id)}
						{@const badge = resultBadge(session.overallPassed)}
						<a
							href="/spu/validation/magnetometer/{session.id}"
							class="flex items-center justify-between rounded border p-3 transition-colors hover:border-[var(--color-tron-cyan)]"
							style="border-color: var(--color-tron-border); background: var(--color-tron-bg-secondary);"
						>
							<div>
								<span class="tron-text-primary font-mono text-sm font-medium">{session.spuUdi ?? 'Unknown SPU'}</span>
								<span class="tron-text-muted ml-2 text-xs">
									{session.completedAt ? new Date(session.completedAt).toLocaleString() : new Date(session.createdAt).toLocaleString()}
								</span>
								{#if session.username}
									<span class="tron-text-muted ml-2 text-xs">by {session.username}</span>
								{/if}
							</div>
							<span
								class="rounded-full px-3 py-1 text-xs font-bold"
								style="color: {badge.color}; background: color-mix(in srgb, {badge.color} 15%, transparent);"
							>
								{badge.text}
							</span>
						</a>
					{/each}
				</div>
			{/if}
		</div>
	</TronCard>
</div>
