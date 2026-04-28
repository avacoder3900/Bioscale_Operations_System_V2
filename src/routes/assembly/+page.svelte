<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard } from '$lib/components/ui';

	let { data, form } = $props();

	const activeWi = $derived(data?.activeWorkInstruction ?? null);
	const startedBuild = $derived((form as any)?.startedBuild ?? null);
</script>

<div class="mx-auto max-w-2xl space-y-8">
	<div class="text-center">
		<h2 class="tron-text-primary mb-2 text-2xl font-bold">Start Assembly</h2>
		<p class="tron-text-muted">Allocate the next UDI and begin a new SPU build</p>
	</div>

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
</div>
