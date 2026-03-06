<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface Session {
		id: string;
		overallPassed: boolean | null;
		status: string;
		createdAt: string | null;
		completedAt: string | null;
		deviceTimestamp: string | null;
		summary: string;
	}

	interface Props {
		data: {
			spu: {
				id: string;
				udi: string;
				particleDeviceId: string | null;
				status: string;
			};
			sessions: Session[];
			criteria: { minZ: number; maxZ: number };
		};
		form: any;
	}

	let { data, form }: Props = $props();

	let readingLatest = $state(false);
	let runningTest = $state(false);

	// S3 — Auto-poll state
	let isMonitoring = $state(false);
	let monitoringStatus = $state('');
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let lastNewDataAt: number = Date.now();
	const POLL_INTERVAL_MS = 5000;
	const AUTO_STOP_MS = 5 * 60 * 1000; // 5 minutes

	function startMonitoring() {
		if (!data.spu.particleDeviceId) return;
		isMonitoring = true;
		lastNewDataAt = Date.now();
		monitoringStatus = 'Monitoring for new test results…';

		pollInterval = setInterval(async () => {
			// Auto-stop after 5 min with no new data
			if (Date.now() - lastNewDataAt > AUTO_STOP_MS) {
				stopMonitoring();
				monitoringStatus = 'Auto-stopped after 5 minutes of no new data.';
				return;
			}

			try {
				const res = await fetch(`/api/validation/poll/${data.spu.id}`);
				if (!res.ok) return;
				const json = await res.json();

				if (json.newSession) {
					lastNewDataAt = Date.now();
					monitoringStatus = `New result detected: ${json.passed ? '✅ PASS' : '❌ FAIL'} — refreshing…`;
					await invalidateAll();
					monitoringStatus = `Latest: ${json.passed ? '✅ PASS' : '❌ FAIL'} — monitoring continues…`;
				}
			} catch {
				// Silent — network error, will retry
			}
		}, POLL_INTERVAL_MS);
	}

	function stopMonitoring() {
		isMonitoring = false;
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	}

	function statusBadge(session: Session): { label: string; color: string } {
		if (session.status === 'running') return { label: 'RUNNING', color: 'var(--color-tron-cyan)' };
		if (session.overallPassed === true) return { label: 'PASS', color: 'var(--color-tron-green)' };
		if (session.overallPassed === false) return { label: 'FAIL', color: 'var(--color-tron-red)' };
		return { label: session.status.toUpperCase(), color: 'var(--color-tron-text-secondary)' };
	}

	function formatDateTime(d: string | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleString();
	}
</script>

<div class="space-y-6">
	<!-- Back link -->
	<a
		href="/spu/validation/magnetometer"
		class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
		</svg>
		Back to Dashboard
	</a>

	<!-- SPU Header -->
	<div class="flex items-start justify-between gap-4">
		<div>
			<h1 class="tron-text-primary text-2xl font-bold font-mono">{data.spu.udi}</h1>
			<p class="tron-text-muted mt-1 text-sm">
				SPU status: <span class="tron-text-primary">{data.spu.status}</span>
				{#if data.spu.particleDeviceId}
					· Device: <span class="font-mono text-xs" style="color: var(--color-tron-cyan);">{data.spu.particleDeviceId}</span>
				{/if}
			</p>
			<p class="tron-text-muted mt-1 text-sm">
				{data.sessions.length} test{data.sessions.length !== 1 ? 's' : ''} total
				· Criteria: Z = {data.criteria.minZ}–{data.criteria.maxZ}
			</p>
		</div>

		<!-- Monitoring indicator -->
		{#if isMonitoring}
			<div class="flex items-center gap-2 rounded border px-3 py-2 text-sm" style="border-color: var(--color-tron-cyan); background: rgba(0,255,255,0.08);">
				<span class="inline-block h-2.5 w-2.5 animate-pulse rounded-full" style="background: var(--color-tron-cyan);"></span>
				<span style="color: var(--color-tron-cyan);">Monitoring</span>
			</div>
		{/if}
	</div>

	<!-- Error / Success messages -->
	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,0,0,0.1)] p-3">
			<p class="text-sm" style="color: var(--color-tron-red);">{form.error}</p>
		</div>
	{/if}

	{#if form && !form.error}
		<div
			class="rounded border p-3"
			style="border-color: {form.newSession ? 'var(--color-tron-green)' : 'var(--color-tron-border)'}; background: {form.newSession ? 'rgba(0,255,128,0.08)' : 'var(--color-tron-bg-secondary)'};"
		>
			<p class="text-sm" style="color: {form.newSession ? 'var(--color-tron-green)' : 'var(--color-tron-text-secondary)'};">
				{form.message}
				{#if form.sessionId}
					— <a href="/spu/validation/magnetometer/{form.sessionId}" class="underline hover:no-underline">View result →</a>
				{/if}
			</p>
		</div>
	{/if}

	<!-- Action Buttons -->
	<TronCard>
		<div class="p-4 space-y-4">
			<h3 class="tron-text-primary font-bold">Device Actions</h3>

			{#if !data.spu.particleDeviceId}
				<p class="tron-text-muted text-sm">No Particle device linked to this SPU.</p>
			{:else}
				<div class="flex flex-wrap gap-3">
					<!-- Read Latest -->
					<form
						method="POST"
						action="?/readLatest"
						use:enhance={() => {
							readingLatest = true;
							return async ({ update }) => {
								readingLatest = false;
								await update();
							};
						}}
					>
						<TronButton type="submit" variant="secondary" disabled={readingLatest} style="min-height: 48px;">
							{readingLatest ? 'Reading…' : '📖 Read Latest from Device'}
						</TronButton>
					</form>

					<!-- Run Test -->
					<form
						method="POST"
						action="?/runTest"
						use:enhance={() => {
							runningTest = true;
							return async ({ update }) => {
								runningTest = false;
								await update();
							};
						}}
					>
						<TronButton type="submit" variant="primary" disabled={runningTest} style="min-height: 48px;">
							{runningTest ? 'Triggering…' : '▶ Run Test on Device'}
						</TronButton>
					</form>

					<!-- Monitoring Toggle -->
					{#if isMonitoring}
						<TronButton variant="secondary" onclick={stopMonitoring} style="min-height: 48px; border-color: var(--color-tron-cyan);">
							⏹ Stop Monitoring
						</TronButton>
					{:else}
						<TronButton variant="secondary" onclick={startMonitoring} style="min-height: 48px;">
							🔄 Start Monitoring
						</TronButton>
					{/if}
				</div>

				{#if isMonitoring && monitoringStatus}
					<p class="text-xs" style="color: var(--color-tron-cyan);">{monitoringStatus}</p>
				{:else if !isMonitoring && monitoringStatus}
					<p class="tron-text-muted text-xs">{monitoringStatus}</p>
				{/if}
			{/if}
		</div>
	</TronCard>

	<!-- Session History -->
	<TronCard>
		<div class="p-4">
			<h3 class="tron-text-primary mb-3 font-bold">Test History</h3>

			{#if data.sessions.length === 0}
				<div class="py-8 text-center">
					<p class="tron-text-muted">No test results yet.</p>
					<p class="tron-text-muted mt-1 text-xs">Run a test or read from the device above.</p>
				</div>
			{:else}
				<div class="space-y-2">
					{#each data.sessions as session (session.id)}
						{@const badge = statusBadge(session)}
						<a
							href="/spu/validation/magnetometer/{session.id}"
							class="flex items-center justify-between rounded border p-3 transition-colors hover:border-[var(--color-tron-cyan)]"
							style="border-color: var(--color-tron-border); background: var(--color-tron-bg-secondary);"
						>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-3">
									<span class="text-sm font-bold" style="color: {badge.color};">{badge.label}</span>
									<span class="tron-text-primary text-sm">{session.summary}</span>
								</div>
								<div class="tron-text-muted mt-0.5 text-xs">
									{formatDateTime(session.completedAt ?? session.createdAt)}
									{#if session.deviceTimestamp}
										· Device TS: {session.deviceTimestamp}
									{/if}
								</div>
							</div>
							<svg class="tron-text-muted ml-3 h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
							</svg>
						</a>
					{/each}
				</div>
			{/if}
		</div>
	</TronCard>
</div>
