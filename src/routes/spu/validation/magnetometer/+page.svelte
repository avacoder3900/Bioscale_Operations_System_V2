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
	let editingCriteria = $state(false);
	let savingCriteria = $state(false);

	// Auto-poll state
	let watching = $state(false);
	let lastHash = $state<string | null>(null);
	let pollInterval = $state<ReturnType<typeof setInterval> | null>(null);
	let pollStatus = $state<string>('');
	let newSessions = $state<any[]>([]);
	let pollError = $state<string | null>(null);
	let pollCount = $state(0);

	const selectedSpu = $derived(data.spus.find(s => s.id === selectedSpuId));

	// Filter out in-progress sessions
	const completedSessions = $derived(
		[...newSessions, ...data.recentSessions].filter(s => s.status !== 'running' && s.status !== 'in_progress')
	);

	// Combined stats
	const totalTests = $derived(data.stats.total + newSessions.length);
	const passedTests = $derived(data.stats.passed + newSessions.filter(s => s.overallPassed).length);
	const failedTests = $derived(data.stats.failed + newSessions.filter(s => !s.overallPassed).length);

	function startWatching() {
		if (!selectedSpu?.particleDeviceId) return;
		watching = true;
		pollError = null;
		pollStatus = 'Watching for new test results…';
		pollCount = 0;

		// First poll seeds the hash, subsequent polls detect changes
		// Server-side dedup prevents duplicates regardless
		pollInterval = setInterval(pollDevice, 5000);
		pollDevice();
	}

	function stopWatching() {
		watching = false;
		pollStatus = '';
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	}

	async function pollDevice() {
		if (!selectedSpu?.particleDeviceId) return;
		pollCount++;

		try {
			const res = await fetch('/api/validation/magnetometer/poll', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					spuId: selectedSpu.id,
					spuUdi: selectedSpu.udi,
					particleDeviceId: selectedSpu.particleDeviceId,
					lastHash
				})
			});

			const result = await res.json();

			if (result.status === 'new_result') {
				lastHash = result.hash;
				pollError = null;

				// Add to live session list
				newSessions = [{
					id: result.session.id,
					status: result.session.overallPassed ? 'completed' : 'failed',
					overallPassed: result.session.overallPassed,
					spuUdi: result.session.spuUdi,
					completedAt: result.session.completedAt,
					startedAt: null,
					createdAt: result.session.completedAt,
					username: null,
					isNew: true
				}, ...newSessions];

				pollStatus = `✅ Test #${newSessions.length} captured — ${result.session.overallPassed ? 'PASS' : 'FAIL'}`;
			} else if (result.status === 'unchanged') {
				lastHash = result.hash;
				pollError = null;
				pollStatus = `Watching… (${pollCount} checks, ${newSessions.length} tests captured)`;
			} else if (result.status === 'no_data') {
				pollStatus = `Watching… no data yet (${pollCount} checks)`;
			} else if (result.status === 'offline') {
				pollError = result.error;
				pollStatus = '⚠️ Device offline — turn on the SPU and try again';
				stopWatching();
			} else if (result.status === 'error') {
				pollError = result.error;
				pollStatus = '';
			}
		} catch (err: any) {
			pollError = err.message || 'Poll failed';
		}
	}

	function resultBadge(passed: boolean | null) {
		if (passed === true) return { text: 'PASS', color: 'var(--color-tron-green)' };
		if (passed === false) return { text: 'FAIL', color: 'var(--color-tron-red)' };
		return { text: 'Pending', color: 'var(--color-tron-text-secondary)' };
	}

	// Cleanup on unmount
	$effect(() => {
		return () => {
			if (pollInterval) clearInterval(pollInterval);
		};
	});

	// Stop watching when SPU changes
	$effect(() => {
		selectedSpuId;  // track dependency
		if (watching) {
			stopWatching();
			newSessions = [];
		}
	});
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
				<div class="tron-text-primary mt-1 text-2xl font-bold">{totalTests}</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="p-4 text-center">
				<div class="text-xs uppercase" style="color: var(--color-tron-green);">Passed</div>
				<div class="mt-1 text-2xl font-bold" style="color: var(--color-tron-green);">{passedTests}</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="p-4 text-center">
				<div class="text-xs uppercase" style="color: var(--color-tron-red);">Failed</div>
				<div class="mt-1 text-2xl font-bold" style="color: var(--color-tron-red);">{failedTests}</div>
			</div>
		</TronCard>
	</div>

	<!-- Device Watcher -->
	<TronCard>
		<div class="p-4 space-y-4">
			<h3 class="tron-text-primary text-lg font-bold">Auto-Capture from Device</h3>
			<p class="tron-text-muted text-sm">Select an SPU and start watching. Results will be captured automatically each time the magnetometer test completes.</p>

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
				<div class="flex items-start gap-2 text-sm text-[var(--color-tron-orange)]">
					<svg class="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<span>This SPU has no Particle device linked. Go to Particle Settings to link it.</span>
				</div>
			{/if}

			<!-- Debug: selected SPU info -->
			{#if selectedSpu}
				<div class="text-xs tron-text-muted">
					Selected: {selectedSpu.udi} | Particle ID: {selectedSpu.particleDeviceId ?? 'NONE'} | Watching: {watching}
				</div>
			{/if}

			<!-- Continuous scan button -->
			{#if watching}
				<button
					onclick={stopWatching}
					class="w-full rounded-lg p-4 text-center font-bold text-lg transition-all cursor-pointer active:scale-[0.98]"
					style="background: var(--color-tron-green); color: var(--color-tron-bg-primary); min-height: 56px; box-shadow: 0 0 20px rgba(0,255,100,0.3);"
				>
					● LIVE — Continuous Scan Active ({pollCount} checks, {newSessions.length} captured) — Tap to Stop
				</button>
				<!-- Scanning animation bar -->
				<div class="relative h-1 w-full overflow-hidden rounded-full" style="background: rgba(0,255,100,0.1);">
					<div class="h-full bg-[var(--color-tron-green)] animate-scan-bar" style="width: 30%; box-shadow: 0 0 8px var(--color-tron-green);"></div>
				</div>
				{#if pollStatus}
					<p class="text-xs text-center" style="color: var(--color-tron-green);">{pollStatus}</p>
				{/if}
			{:else}
				<button
					onclick={startWatching}
					disabled={!selectedSpu?.particleDeviceId}
					class="w-full rounded-lg p-4 text-center font-bold text-lg transition-all cursor-pointer hover:opacity-90 active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed"
					style="background: linear-gradient(135deg, var(--color-tron-cyan), var(--color-tron-green)); color: var(--color-tron-bg-primary); min-height: 56px;"
				>
					👁 Start Continuous Scan
				</button>
			{/if}

			{#if pollError}
				<div class="rounded-lg p-3" style="background: rgba(255,0,0,0.1); border: 1px solid var(--color-tron-red);">
					<div class="flex items-start gap-2 text-sm text-[var(--color-tron-red)]">
						<span>⚠️ {pollError}</span>
					</div>
				</div>
			{/if}

			<!-- New results indicator -->
			{#if newSessions.length > 0}
				<div class="rounded-lg p-3" style="background: color-mix(in srgb, var(--color-tron-green) 10%, transparent); border: 1px solid var(--color-tron-green);">
					<span class="text-sm font-medium" style="color: var(--color-tron-green);">
						🎯 {newSessions.length} new test{newSessions.length > 1 ? 's' : ''} captured this session
					</span>
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

	<!-- Watching banner animation -->
	{#if watching}
		<style>
			@keyframes scan-bar {
				0% { transform: translateX(-100%); }
				100% { transform: translateX(400%); }
			}
			.animate-scan-bar {
				animation: scan-bar 2s ease-in-out infinite;
			}
			@keyframes slider-pulse {
				0%, 100% { transform: translateX(22px) scale(1); }
				50% { transform: translateX(22px) scale(1.15); }
			}
			.animate-slider-pulse {
				animation: slider-pulse 1.5s ease-in-out infinite !important;
			}
		</style>
	{/if}

	<!-- Recent Sessions -->
	<TronCard>
		<div class="p-4">
			<h3 class="tron-text-primary mb-3 font-bold">Test Results</h3>
			{#if completedSessions.length === 0}
				<p class="tron-text-muted text-sm">No tests recorded yet. Select an SPU and start watching.</p>
			{:else}
				<div class="space-y-2">
					{#each completedSessions as session (session.id)}
						{@const badge = resultBadge(session.overallPassed)}
						<a
							href="/spu/validation/magnetometer/{session.id}"
							class="flex items-center justify-between rounded border p-3 transition-colors hover:border-[var(--color-tron-cyan)]"
							style="border-color: {session.isNew ? 'var(--color-tron-green)' : 'var(--color-tron-border)'}; background: var(--color-tron-bg-secondary);"
						>
							<div class="flex items-center gap-2">
								{#if session.isNew}
									<span class="text-xs font-bold px-1.5 py-0.5 rounded" style="background: var(--color-tron-green); color: var(--color-tron-bg-primary);">NEW</span>
								{/if}
								<span class="tron-text-primary font-mono text-sm font-medium">{session.spuUdi ?? 'Unknown SPU'}</span>
								<span class="tron-text-muted text-xs">
									{session.completedAt ? new Date(session.completedAt).toLocaleString() : new Date(session.createdAt).toLocaleString()}
								</span>
								{#if session.username}
									<span class="tron-text-muted text-xs">by {session.username}</span>
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
