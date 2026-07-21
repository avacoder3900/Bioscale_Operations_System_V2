<script lang="ts">
	import { enhance } from '$app/forms';

	interface RosterSpu {
		id: string;
		udi: string;
		batchNumber: string | null;
		status: string;
		validationStatus: string;
		magStatus: string;
		thermoStatus: string;
		activeRun: { runId: string; runNumber: string } | null;
		createdAt: string | null;
	}

	interface RunSummary {
		id: string;
		runNumber: string;
		name: string | null;
		status: string;
		spuCount: number;
		progress: { passed: number; total: number };
		steps: string[];
		stepSummary: Record<string, { passed: number; failed: number; uploaded: number; total: number }>;
		startedAt: string | null;
		completedAt: string | null;
		createdBy: string | null;
	}

	const SHORT_STEP_LABELS: Record<string, string> = {
		magnetometer: 'Mag',
		thermocouple: 'Thermo',
		optical_confirmation: 'Optical'
	};

	interface Props {
		data: { spus: RosterSpu[]; runs: RunSummary[] };
		form: { error?: string } | null;
	}

	let { data, form }: Props = $props();

	let runName = $state('');
	let statusFilter = $state<'all' | 'in_progress' | 'completed' | 'aborted'>('all');
	let isSubmitting = $state(false);

	// Combobox picker state: type to search, dropdown to scroll, each selection
	// joins the staged validation group below.
	let query = $state('');
	let picked = $state<RosterSpu[]>([]);
	let dropdownOpen = $state(false);
	let highlightIndex = $state(0);

	let pickedIds = $derived(picked.map(p => p.id));
	let available = $derived(data.spus.filter(s => !s.activeRun && !pickedIds.includes(s.id)));
	let matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return available;
		return available.filter(s =>
			s.udi.toLowerCase().includes(q) || (s.batchNumber ?? '').toLowerCase().includes(q)
		);
	});

	let filteredRuns = $derived(
		statusFilter === 'all' ? data.runs : data.runs.filter(r => r.status === statusFilter)
	);

	function addToGroup(spu: RosterSpu) {
		if (pickedIds.includes(spu.id)) return;
		picked.push(spu);
		query = '';
		highlightIndex = 0;
	}

	function removeFromGroup(id: string) {
		picked = picked.filter(p => p.id !== id);
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (!dropdownOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
			dropdownOpen = true;
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightIndex = Math.min(highlightIndex + 1, matches.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightIndex = Math.max(highlightIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const hit = matches[highlightIndex] ?? matches[0];
			if (hit) addToGroup(hit);
		} else if (e.key === 'Escape') {
			dropdownOpen = false;
		}
	}

	function statusChip(status: string): string {
		if (status === 'passed') return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
		if (status === 'failed') return 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]';
		if (status === 'uploaded') return 'bg-[var(--color-tron-orange)]/20 text-[var(--color-tron-orange)]';
		return 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]';
	}

	function runChip(status: string): string {
		if (status === 'in_progress') return 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]';
		if (status === 'completed') return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
		return 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]';
	}

	function fmtDate(d: string | null): string {
		return d ? new Date(d).toLocaleString() : '—';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Validation Runs</h1>
			<p class="tron-text-muted mt-1">Batch multiple SPUs into one tracked validation run</p>
		</div>
	</div>

	{#if form?.error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
			{form.error}
		</div>
	{/if}

	<!-- Runs (top): each run with its per-step validation status -->
	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Runs</h2>
			<div class="flex gap-2">
				{#each [['all', 'All'], ['in_progress', 'In Progress'], ['completed', 'Completed'], ['aborted', 'Aborted']] as [value, label] (value)}
					<button
						type="button"
						onclick={() => statusFilter = value as typeof statusFilter}
						class="rounded-lg px-3 py-1 text-xs font-medium transition-colors
							{statusFilter === value
								? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
								: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]'}"
					>
						{label}
					</button>
				{/each}
			</div>
		</div>

		{#if filteredRuns.length === 0}
			<p class="tron-text-muted p-6 text-sm">No validation runs yet — build a group below to start one.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left">
							<th class="tron-text-muted p-3 font-medium">Run #</th>
							<th class="tron-text-muted p-3 font-medium">Name</th>
							<th class="tron-text-muted p-3 font-medium">SPUs</th>
							<th class="tron-text-muted p-3 font-medium">Validation Status</th>
							<th class="tron-text-muted p-3 font-medium">Status</th>
							<th class="tron-text-muted p-3 font-medium">Started</th>
							<th class="tron-text-muted p-3 font-medium">By</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each filteredRuns as run (run.id)}
							<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
								<td class="p-3">
									<a href="/validation/runs/{run.id}" class="tron-heading font-medium text-[var(--color-tron-cyan)] hover:underline">{run.runNumber}</a>
								</td>
								<td class="p-3">{run.name ?? '—'}</td>
								<td class="p-3">{run.spuCount}</td>
								<td class="p-3">
									<div class="flex flex-wrap items-center gap-2">
										{#each run.steps as step (step)}
											{@const s = run.stepSummary[step]}
											{#if s}
												{@const pending = s.total - s.passed - s.failed - s.uploaded}
												<span class="flex items-center gap-1 rounded-full bg-[var(--color-tron-bg-tertiary)] px-2 py-1 text-xs">
													<span class="tron-text-muted">{SHORT_STEP_LABELS[step] ?? step}:</span>
													{#if s.passed > 0}<span class="font-medium text-[var(--color-tron-green)]">{s.passed}✓</span>{/if}
													{#if s.failed > 0}<span class="font-medium text-[var(--color-tron-red)]">{s.failed}✗</span>{/if}
													{#if s.uploaded > 0}<span class="font-medium text-[var(--color-tron-orange)]">{s.uploaded}↑</span>{/if}
													{#if pending > 0}<span class="tron-text-muted">{pending}·</span>{/if}
													{#if s.total === 0}<span class="tron-text-muted">—</span>{/if}
												</span>
											{/if}
										{/each}
									</div>
								</td>
								<td class="p-3">
									<span class="rounded-full px-2 py-1 text-xs font-medium {runChip(run.status)}">
										{run.status === 'in_progress' ? 'In Progress' : run.status === 'completed' ? 'Completed' : 'Aborted'}
									</span>
								</td>
								<td class="tron-text-muted p-3">{fmtDate(run.startedAt)}</td>
								<td class="tron-text-muted p-3">{run.createdBy ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="tron-text-muted border-t border-[var(--color-tron-border)] px-4 py-2 text-xs">
				✓ passed · ✗ failed · ↑ uploaded (awaiting evaluation) · &nbsp;·&nbsp; pending
			</p>
		{/if}
	</div>

	<!-- Build validation group -->
	<form
		method="POST"
		action="?/startRun"
		use:enhance={() => {
			isSubmitting = true;
			return async ({ update }) => {
				await update();
				isSubmitting = false;
			};
		}}
	>
		<div class="tron-card">
			<div class="border-b border-[var(--color-tron-border)] p-4">
				<h2 class="tron-heading text-lg font-semibold">Build Validation Group</h2>
				<p class="tron-text-muted mt-1 text-sm">Search or scroll to find an SPU, select it to add it to the group, then start the run.</p>
			</div>

			<div class="space-y-4 p-4">
				<!-- Combobox: search + scrollable dropdown -->
				<div class="relative max-w-md">
					<input
						type="text"
						bind:value={query}
						placeholder="Search SPU by UDI or batch… ({available.length} available)"
						class="tron-input w-full rounded-lg px-4 py-3"
						autocomplete="off"
						onfocus={() => { dropdownOpen = true; highlightIndex = 0; }}
						onblur={() => dropdownOpen = false}
						oninput={() => { dropdownOpen = true; highlightIndex = 0; }}
						onkeydown={onSearchKeydown}
					/>
					{#if dropdownOpen}
						<div class="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] shadow-lg">
							{#if matches.length === 0}
								<p class="tron-text-muted p-3 text-sm">
									{available.length === 0 ? 'No SPUs available — all are in a run already or none are in validation.' : `No SPU matches “${query}”`}
								</p>
							{:else}
								{#each matches as spu, i (spu.id)}
									<button
										type="button"
										class="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors
											{i === highlightIndex ? 'bg-[var(--color-tron-cyan)]/15' : 'hover:bg-[var(--color-tron-bg-tertiary)]'}"
										onmousedown={(e) => { e.preventDefault(); addToGroup(spu); }}
										onmouseenter={() => highlightIndex = i}
									>
										<span class="tron-heading font-medium">{spu.udi}</span>
										<span class="flex items-center gap-2">
											<span class="tron-text-muted text-xs capitalize">{spu.status}</span>
											{#if spu.batchNumber}
												<span class="tron-text-muted text-xs">batch {spu.batchNumber}</span>
											{/if}
											<span class="rounded-full px-2 py-0.5 text-xs font-medium capitalize {statusChip(spu.magStatus)}">mag: {spu.magStatus}</span>
											<span class="rounded-full px-2 py-0.5 text-xs font-medium capitalize {statusChip(spu.thermoStatus)}">thermo: {spu.thermoStatus}</span>
										</span>
									</button>
								{/each}
							{/if}
						</div>
					{/if}
				</div>

				<!-- Staged group -->
				{#if picked.length === 0}
					<p class="tron-text-muted text-sm">No SPUs in the group yet.</p>
				{:else}
					<div>
						<h3 class="tron-text-muted mb-2 text-xs font-medium uppercase">Validation group ({picked.length})</h3>
						<div class="flex flex-wrap gap-2">
							{#each picked as spu (spu.id)}
								<span class="flex items-center gap-2 rounded-full border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 py-1.5 pr-2 pl-3 text-sm">
									<input type="hidden" name="spuIds" value={spu.id} />
									<span class="tron-heading font-medium">{spu.udi}</span>
									{#if spu.batchNumber}
										<span class="tron-text-muted text-xs">({spu.batchNumber})</span>
									{/if}
									<button
										type="button"
										onclick={() => removeFromGroup(spu.id)}
										class="tron-text-muted rounded-full px-1.5 text-xs hover:text-[var(--color-tron-red)]"
										title="Remove {spu.udi} from group"
									>
										✕
									</button>
								</span>
							{/each}
						</div>
					</div>
				{/if}

				<div class="flex items-center gap-3 border-t border-[var(--color-tron-border)] pt-4">
					<input
						type="text"
						name="name"
						bind:value={runName}
						placeholder="Run name (optional)"
						class="tron-input rounded-lg px-3 py-2 text-sm"
					/>
					<button
						type="submit"
						disabled={picked.length === 0 || isSubmitting}
						class="rounded-lg bg-[var(--color-tron-orange)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isSubmitting ? 'Starting…' : `Start Validation Run (${picked.length})`}
					</button>
				</div>
			</div>
		</div>
	</form>

	<!-- All SPUs (overview) -->
	<div class="tron-card">
		<div class="border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">All SPUs ({data.spus.length})</h2>
		</div>

		{#if data.spus.length === 0}
			<p class="tron-text-muted p-6 text-sm">No SPUs registered yet.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left">
							<th class="tron-text-muted p-3 font-medium">UDI</th>
							<th class="tron-text-muted p-3 font-medium">Batch</th>
							<th class="tron-text-muted p-3 font-medium">Status</th>
							<th class="tron-text-muted p-3 font-medium">Mag</th>
							<th class="tron-text-muted p-3 font-medium">Thermo</th>
							<th class="tron-text-muted p-3 font-medium">Active Run</th>
							<th class="p-3"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each data.spus as spu (spu.id)}
							<tr class={spu.activeRun ? 'opacity-60' : ''}>
								<td class="p-3">
									<a href="/spu/{spu.id}" class="tron-heading font-medium hover:text-[var(--color-tron-cyan)] hover:underline">{spu.udi}</a>
								</td>
								<td class="tron-text-muted p-3">{spu.batchNumber ?? '—'}</td>
								<td class="p-3 capitalize">{spu.status}</td>
								<td class="p-3">
									<span class="rounded-full px-2 py-1 text-xs font-medium capitalize {statusChip(spu.magStatus)}">{spu.magStatus}</span>
								</td>
								<td class="p-3">
									<span class="rounded-full px-2 py-1 text-xs font-medium capitalize {statusChip(spu.thermoStatus)}">{spu.thermoStatus}</span>
								</td>
								<td class="p-3">
									{#if spu.activeRun}
										<a href="/validation/runs/{spu.activeRun.runId}" class="text-[var(--color-tron-cyan)] hover:underline">{spu.activeRun.runNumber}</a>
									{:else}
										<span class="tron-text-muted">—</span>
									{/if}
								</td>
								<td class="p-3 text-right">
									{#if spu.activeRun}
										<span class="tron-text-muted text-xs">in run</span>
									{:else if pickedIds.includes(spu.id)}
										<span class="text-xs text-[var(--color-tron-cyan)]">in group ✓</span>
									{:else}
										<button
											type="button"
											onclick={() => addToGroup(spu)}
											class="rounded-lg border border-[var(--color-tron-cyan)]/40 px-3 py-1 text-xs font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/10"
										>
											+ Add to group
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

</div>
