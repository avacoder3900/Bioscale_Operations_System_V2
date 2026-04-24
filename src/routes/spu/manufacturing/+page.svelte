<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	function relativeTime(iso: string | null): string {
		if (!iso) return '—';
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) return '—';
		const diffMs = Date.now() - then;
		if (diffMs < 0) return 'just now';
		const sec = Math.floor(diffMs / 1000);
		if (sec < 60) return `${sec}s ago`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const day = Math.floor(hr / 24);
		return `${day}d ago`;
	}

	function statusBadgeClass(status: string): string {
		if (status === 'paused') return 'tron-badge tron-badge-warning';
		return 'tron-badge tron-badge-info';
	}
</script>

<div class="space-y-8">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">SPU Manufacturing</h1>
			<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
				In-flight SPU builds and new-build launcher
			</p>
		</div>
		{#if data.canUploadWI}
			<a
				href="/documents/instructions/upload-parse"
				class="tron-btn-secondary"
			>
				Upload Work Instruction
			</a>
		{/if}
	</div>

	<!-- Start New Build panel -->
	{#if data.canStartNew}
		<section class="tron-card space-y-4">
			<div class="flex items-start justify-between gap-4">
				<div>
					<h2 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">
						Start New Build
					</h2>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Next UDI will be
						<span class="ml-1 font-mono text-[var(--color-tron-text-secondary)] opacity-60">
							{data.nextUdiPreview}
						</span>
					</p>
				</div>
			</div>

			{#if data.activeWorkInstructions.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					No active work instructions available. Upload one to begin a build.
				</p>
			{:else}
				<form method="POST" action="?/startNewBuild" use:enhance class="flex flex-wrap items-end gap-3">
					<div class="flex-1 min-w-[240px]">
						<label
							for="workInstructionId"
							class="mb-1 block text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]"
						>
							Work Instruction
						</label>
						<select
							id="workInstructionId"
							name="workInstructionId"
							required
							class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)] focus:border-[var(--color-tron-cyan)] focus:outline-none"
						>
							<option value="">Select a work instruction…</option>
							{#each data.activeWorkInstructions as wi (wi._id)}
								<option value={wi._id}>
									{wi.documentNumber ? wi.documentNumber + ' — ' : ''}{wi.title}
									{wi.currentVersion !== null ? ' (v' + wi.currentVersion + ')' : ''}
								</option>
							{/each}
						</select>
					</div>
					<button type="submit" class="tron-btn-primary">Start Build</button>
				</form>
			{/if}
		</section>
	{/if}

	<!-- In-flight builds grid -->
	<section class="space-y-3">
		<div class="flex items-baseline justify-between">
			<h2 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">In-Flight Builds</h2>
			<span class="text-xs text-[var(--color-tron-text-secondary)]">
				{data.inFlightBuilds.length} active
			</span>
		</div>

		{#if data.inFlightBuilds.length === 0}
			<div class="tron-card text-center">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					No builds currently in progress.
				</p>
			</div>
		{:else}
			<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
				{#each data.inFlightBuilds as build (build.sessionId)}
					<div class="tron-card-interactive flex flex-col gap-3">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<p class="font-mono text-sm font-semibold text-[var(--color-tron-cyan)] truncate">
									{build.udi || '(no UDI)'}
								</p>
								<p
									class="mt-1 text-xs text-[var(--color-tron-text-secondary)] truncate"
									title={build.workInstructionTitle}
								>
									{build.workInstructionTitle || 'No work instruction'}
								</p>
							</div>
							<span class={statusBadgeClass(build.status)}>
								{build.status === 'paused' ? 'PAUSED' : 'IN PROGRESS'}
							</span>
						</div>

						<div class="space-y-1 text-xs text-[var(--color-tron-text-secondary)]">
							<div class="flex justify-between">
								<span>Step</span>
								<span class="text-[var(--color-tron-text-primary)]">
									{build.currentStepIndex + 1} / {build.totalSteps || '?'}
									{#if build.currentStepTitle}
										<span class="ml-1 opacity-70">— {build.currentStepTitle}</span>
									{/if}
								</span>
							</div>
							<div class="flex justify-between">
								<span>Operator</span>
								<span class="text-[var(--color-tron-text-primary)]">
									{build.operatorUsername || '—'}
								</span>
							</div>
							<div class="flex justify-between">
								<span>Started</span>
								<span class="text-[var(--color-tron-text-primary)]">
									{relativeTime(build.startedAt)}
								</span>
							</div>
						</div>

						<!-- Progress bar -->
						<div class="h-2 w-full overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
							<div
								class="h-full bg-[var(--color-tron-cyan)] transition-all"
								style="width: {build.percentComplete}%"
							></div>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								{build.percentComplete}% complete
							</span>
							<a
								href="/assembly/{build.sessionId}"
								class="tron-btn-primary text-xs"
							>
								Resume
							</a>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>
