<script lang="ts">
	import { enhance } from '$app/forms';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface Props {
		data: {
			magnetometer: {
				id: string;
				name: string;
				particleDeviceId: string;
				serialNumber: string | null;
				status: string;
			} | null;
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
			stats: { total: number; passed: number; failed: number; inProgress: number };
			criteria: { minZ: number; maxZ: number };
		};
		form: any;
	}

	let { data, form }: Props = $props();

	let selectedSpuId = $state('');
	let reading = $state(false);
	let registering = $state(false);
	let editingCriteria = $state(false);
	let savingCriteria = $state(false);
	let showRegisterForm = $state(false);

	function resultBadge(status: string, passed: boolean | null) {
		if (status === 'running' || status === 'in_progress') return { text: 'Running', color: 'var(--color-tron-cyan)' };
		if (passed === true) return { text: 'PASS', color: 'var(--color-tron-green)' };
		if (passed === false) return { text: 'FAIL', color: 'var(--color-tron-red)' };
		return { text: status, color: 'var(--color-tron-text-secondary)' };
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

	<!-- Magnetometer Equipment Status -->
	<TronCard>
		<div class="p-4 space-y-3">
			<div class="flex items-center justify-between">
				<h3 class="tron-text-primary font-bold">🧲 Magnetometer Equipment</h3>
				{#if data.magnetometer}
					<span class="rounded-full px-3 py-1 text-xs font-bold"
						style="color: var(--color-tron-green); background: color-mix(in srgb, var(--color-tron-green) 15%, transparent);">
						● Active
					</span>
				{:else}
					<span class="rounded-full px-3 py-1 text-xs font-bold"
						style="color: var(--color-tron-red); background: color-mix(in srgb, var(--color-tron-red) 15%, transparent);">
						● Not Registered
					</span>
				{/if}
			</div>

			{#if data.magnetometer}
				<div class="grid grid-cols-3 gap-4 text-sm">
					<div>
						<span class="tron-text-muted text-xs">Name</span>
						<p class="tron-text-primary font-medium">{data.magnetometer.name}</p>
					</div>
					<div>
						<span class="tron-text-muted text-xs">Particle Device ID</span>
						<p class="tron-text-primary font-mono text-xs">{data.magnetometer.particleDeviceId}</p>
					</div>
					<div>
						<span class="tron-text-muted text-xs">Serial Number</span>
						<p class="tron-text-primary">{data.magnetometer.serialNumber ?? '—'}</p>
					</div>
				</div>
				<p class="tron-text-muted text-xs">This magnetometer is linked to all SPUs automatically. Select an SPU below to read validation data.</p>
				<button type="button" onclick={() => (showRegisterForm = !showRegisterForm)} class="tron-text-muted text-xs underline">
					Replace with different magnetometer
				</button>
			{/if}

			{#if !data.magnetometer || showRegisterForm}
				{#if !data.magnetometer}
					<p class="tron-text-muted text-sm">No magnetometer registered. Register your magnetometer device to enable validation for all SPUs.</p>
				{/if}

				{#if form?.magnetometerRegistered}
					<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,0,0.1)] p-3">
						<p class="text-sm" style="color: var(--color-tron-green);">✓ Magnetometer registered and linked to all SPUs.</p>
					</div>
				{/if}

				<form
					method="POST"
					action="?/registerMagnetometer"
					use:enhance={() => {
						registering = true;
						return async ({ update }) => {
							registering = false;
							showRegisterForm = false;
							await update();
						};
					}}
					class="space-y-3"
				>
					<div class="grid grid-cols-3 gap-3">
						<div>
							<label for="mag-name" class="tron-label text-xs">Name</label>
							<input id="mag-name" name="name" type="text" class="tron-input w-full" placeholder="e.g. Magnetometer V2" style="min-height: 44px;" required />
						</div>
						<div>
							<label for="mag-device-id" class="tron-label text-xs">Particle Device ID</label>
							<input id="mag-device-id" name="particleDeviceId" type="text" class="tron-input w-full" placeholder="e.g. e00fce68xxxxxxxx" style="min-height: 44px;" required />
						</div>
						<div>
							<label for="mag-serial" class="tron-label text-xs">Serial Number (optional)</label>
							<input id="mag-serial" name="serialNumber" type="text" class="tron-input w-full" placeholder="e.g. MAG-001" style="min-height: 44px;" />
						</div>
					</div>
					<TronButton type="submit" variant="primary" disabled={registering} style="min-height: 44px;">
						{registering ? 'Registering…' : '🧲 Register Magnetometer'}
					</TronButton>
				</form>
			{/if}
		</div>
	</TronCard>

	<!-- Stats -->
	<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
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
		<TronCard>
			<div class="p-4 text-center">
				<div class="text-xs uppercase" style="color: var(--color-tron-cyan);">In Progress</div>
				<div class="mt-1 text-2xl font-bold" style="color: var(--color-tron-cyan);">{data.stats.inProgress}</div>
			</div>
		</TronCard>
	</div>

	<!-- Read Magnetometer Data -->
	{#if data.magnetometer}
		<TronCard>
			<div class="p-4 space-y-4">
				<h3 class="tron-text-primary text-lg font-bold">📡 Read Magnetometer Validation</h3>

				<div>
					<label for="spu-select" class="tron-label">Select SPU</label>
					<select id="spu-select" class="tron-select w-full" style="min-height: 48px;" bind:value={selectedSpuId}>
						<option value="">Choose an SPU…</option>
						{#each data.spus as spu (spu.id)}
							<option value={spu.id}>{spu.udi} ({spu.status})</option>
						{/each}
					</select>
				</div>

				{#if selectedSpuId}
					<div class="tron-text-muted text-xs">
						Reading from: <span class="font-mono tron-text-primary">{data.magnetometer.name}</span>
						· Magnetometer auto-updates every 2s · No trigger needed
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
						<TronButton type="submit" variant="primary" disabled={reading} style="min-height: 48px; width: 100%;">
							{reading ? 'Reading from Magnetometer…' : '📡 Read Magnetometer Data'}
						</TronButton>
					</form>
				{/if}
			</div>
		</TronCard>
	{/if}

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
			{#if data.recentSessions.length === 0}
				<p class="tron-text-muted text-sm">No tests run yet.</p>
			{:else}
				<div class="space-y-2">
					{#each data.recentSessions as session (session.id)}
						{@const badge = resultBadge(session.status, session.overallPassed)}
						<a
							href="/spu/validation/magnetometer/{session.id}"
							class="flex items-center justify-between rounded border p-3 transition-colors hover:border-[var(--color-tron-cyan)]"
							style="border-color: var(--color-tron-border); background: var(--color-tron-bg-secondary);"
						>
							<div>
								<span class="tron-text-primary font-mono text-sm font-medium">{session.spuUdi ?? 'Unknown SPU'}</span>
								<span class="tron-text-muted ml-2 text-xs">
									{session.completedAt ? new Date(session.completedAt).toLocaleString() : session.startedAt ? new Date(session.startedAt).toLocaleString() : ''}
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
