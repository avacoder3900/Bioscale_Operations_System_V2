<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard } from '$lib/components/ui';

	let { data, form } = $props();

	const activeWi = $derived(data?.activeWorkInstruction ?? null);
	const startedBuild = $derived((form as any)?.startedBuild ?? null);
	const inProgress = $derived(data?.inProgressBuilds ?? []);

	function stepLabel(b: any): string {
		if (b.sessionId == null) return 'Not started';
		const idx = (b.currentStepIndex ?? 0) + 1;
		return b.totalSteps ? `Step ${idx} of ${b.totalSteps}` : `Step ${idx}`;
	}
</script>

<div class="mx-auto max-w-4xl space-y-8">
	<div class="text-center">
		<h2 class="tron-text-primary mb-2 text-2xl font-bold">Start Assembly</h2>
		<p class="tron-text-muted">Allocate the next UDI and begin a new SPU build</p>
	</div>

	<TronCard>
		<div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
			<div class="flex-1 space-y-2">
				<p class="tron-text-primary font-medium">Upload Work Instructions</p>
				<p class="tron-text-muted text-xs">
					Parser scans the .docx or .pdf for the patterns below and auto-generates barcode-scan fields for the entire WI. You confirm before induction.
				</p>
				<ul class="tron-text-muted ml-4 list-disc text-xs">
					<li>
						Part references: <code class="text-[var(--color-tron-cyan)]">PT-SPU-XXX</code>
						(3+ digits)
					</li>
					<li>
						Quantities: <code class="text-[var(--color-tron-cyan)]">qty=X</code>
						(case-insensitive; defaults to <code>1</code> if absent)
					</li>
					<li>
						One <code>barcode_scan</code> field per part-quantity unit
						(e.g. <code>qty=2</code> → 2 scans for that part in that step)
					</li>
					<li>
						Non-PT-SPU references (<code>SBA-SPU-…</code>, <code>IFU-SPU-…</code>) are
						flagged for reviewer attention
					</li>
					<li>Step segmentation on numbered headings or <code>Step N</code> markers</li>
				</ul>
			</div>
			<a
				href="/spu/work-instruction"
				class="self-start whitespace-nowrap rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90"
			>
				Upload Work Instructions
			</a>
		</div>
	</TronCard>

	{#if !startedBuild}
		<TronCard>
			<form method="POST" action="?/startNewBuild" use:enhance class="space-y-6">
				<div class="space-y-3 text-center">
					<p class="tron-text-primary text-lg font-medium">Ready to begin a new SPU build?</p>
					<p class="tron-text-muted text-sm">
						The system will allocate the next available UDI and create a draft SPU.
					</p>
					<button
						type="submit"
						class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 font-semibold text-black hover:opacity-90"
					>
						Allocate UDI &amp; Start New Build
					</button>
				</div>
				{#if (form as any)?.error}
					<div class="rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-4">
						<p class="text-sm text-[var(--color-tron-red)]">{(form as any).error}</p>
					</div>
				{/if}
			</form>
		</TronCard>
	{:else}
		<TronCard>
			<div class="space-y-4 text-center">
				<p class="tron-text-muted text-xs uppercase tracking-wide">
					{startedBuild.resumed ? 'Resumed Draft' : 'UDI Assigned'}
				</p>
				<p class="tron-text-primary font-mono text-3xl font-bold">{startedBuild.udi}</p>
				<p class="tron-text-muted text-sm">SPU draft created. Continue to the work instruction below.</p>
			</div>
		</TronCard>

		<TronCard>
			<div class="space-y-2">
				<p class="tron-text-muted text-xs uppercase tracking-wide">Build Details</p>
				<p class="tron-text-primary text-sm">Placeholder — build details widget will populate here.</p>
				<p class="tron-text-muted font-mono text-xs">SPU ID: {startedBuild.spuId}</p>
			</div>
		</TronCard>

		<TronCard>
			{#if startedBuild.workInstruction}
				<div class="space-y-4">
					<div>
						<p class="tron-text-muted text-xs uppercase tracking-wide">Active Work Instruction</p>
						<p class="tron-text-primary text-lg font-medium">{startedBuild.workInstruction.title}</p>
						<p class="tron-text-muted text-xs">
							Revision {startedBuild.workInstruction.revision || '-'} · v{startedBuild.workInstruction.currentVersion}
						</p>
					</div>
					<form method="POST" action="?/openWorkInstruction" use:enhance>
						<input type="hidden" name="spuId" value={startedBuild.spuId} />
						<button
							type="submit"
							class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 font-semibold text-black hover:opacity-90"
						>
							Open Work Instruction
						</button>
					</form>
				</div>
			{:else}
				<div class="space-y-3">
					<p class="tron-text-primary font-medium">No active SPU Work Instruction</p>
					<p class="tron-text-muted text-sm">
						Upload one to begin assembly.
					</p>
					<a
						href="/spu/work-instruction"
						class="inline-block rounded-lg border border-[var(--color-tron-cyan)] px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[rgba(0,229,255,0.1)]"
					>
						Manage Work Instruction
					</a>
				</div>
			{/if}
		</TronCard>
	{/if}

	{#if activeWi}
		<TronCard>
			<div class="text-xs">
				<p class="tron-text-muted uppercase tracking-wide">Current SPU Work Instruction</p>
				<p class="tron-text-primary mt-1">{activeWi.title} · rev {activeWi.revision || '-'} · v{activeWi.currentVersion}</p>
			</div>
		</TronCard>
	{/if}

	<section class="space-y-3">
		<div class="flex items-baseline justify-between">
			<h3 class="tron-text-primary text-lg font-semibold">In-Progress Builds</h3>
			<p class="tron-text-muted text-xs">{inProgress.length} unit{inProgress.length === 1 ? '' : 's'} on the line</p>
		</div>

		{#if inProgress.length === 0}
			<TronCard>
				<p class="tron-text-muted text-sm">No builds in progress.</p>
			</TronCard>
		{:else}
			<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
				{#each inProgress as b}
					<TronCard>
						<div class="space-y-3">
							<div class="flex items-start justify-between gap-2">
								<p class="tron-text-primary font-mono text-base font-bold">{b.udi}</p>
								<div class="flex flex-shrink-0 gap-1">
									<span class="rounded bg-[rgba(0,229,255,0.15)] px-2 py-0.5 text-xs uppercase tracking-wide text-[var(--color-tron-cyan)]">
										{b.status}
									</span>
									{#if b.isStale}
										<span class="rounded bg-[rgba(255,51,102,0.15)] px-2 py-0.5 text-xs uppercase tracking-wide text-[var(--color-tron-red)]">
											Stale
										</span>
									{/if}
								</div>
							</div>
							<div class="grid grid-cols-2 gap-2 text-xs">
								<div>
									<p class="tron-text-muted uppercase tracking-wide">Step</p>
									<p class="tron-text-primary">{stepLabel(b)}</p>
								</div>
								<div>
									<p class="tron-text-muted uppercase tracking-wide">Owner</p>
									<p class="tron-text-primary">{b.ownerUsername ?? '—'}</p>
								</div>
							</div>
							{#if b.sessionId}
								<a
									href="/assembly/{b.sessionId}"
									class="block w-full rounded-lg border border-[var(--color-tron-cyan)] px-3 py-2 text-center text-xs text-[var(--color-tron-cyan)] hover:bg-[rgba(0,229,255,0.1)]"
								>
									Resume Build
								</a>
							{:else}
								<form method="POST" action="?/openWorkInstruction" use:enhance>
									<input type="hidden" name="spuId" value={b.spuId} />
									<button
										type="submit"
										class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-3 py-2 text-xs font-semibold text-black hover:opacity-90"
									>
										Continue to Work Instruction
									</button>
								</form>
							{/if}
						</div>
					</TronCard>
				{/each}
			</div>
		{/if}
	</section>
</div>
