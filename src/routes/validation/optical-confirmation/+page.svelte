<script lang="ts">
	import { enhance } from '$app/forms';
	import GroupPill from '$lib/components/validation/optical/GroupPill.svelte';

	interface Props {
		data: {
			assays: Array<{ id: string; name: string; skuCode: string; duration: number | null; bcodeSteps: number }>;
			groups: Array<{
				id: string; name: string; description: string | null; color: string; count: number;
			}>;
			cartridges: Array<{
				id: string; barcode: string; assayName: string | null;
				status: string; ran: boolean; assigned: boolean;
				spuUdi: string | null; spuDeviceId: string | null;
				group: { id: string; name: string; color: string } | null;
				assignedAt: string | null; underwayAt: string | null; completedAt: string | null;
				result: { profileName: string | null; computedAt: string | null } | null;
				analysis: {
					ratioByChannel: { A: number | null; B: number | null; C: number | null };
					warning: boolean;
					crossWellCv: number | null;
				} | null;
			}>;
		};
		form: {
			success?: boolean; error?: string;
			createdCount?: number; skipped?: Array<{ barcode: string; reason: string }>;
			bcodeSteps?: number; assayName?: string;
			// group actions
			groupSaved?: boolean; groupArchived?: boolean; groupError?: string;
			groupId?: string; groupName?: string;
			addedCount?: number; totalCount?: number; removedCount?: number;
			movedFrom?: Array<{ name: string; count: number }>;
			existingGroupId?: string; existingGroupName?: string;
		} | null;
	}

	let { data, form }: Props = $props();

	const GROUP_COLORS = ['cyan', 'green', 'purple', 'yellow', 'orange', 'blue'];

	// Single optical assay — preselected, not user-changeable.
	const assay = $derived(data.assays[0] ?? null);

	let count = $state(1);
	let barcodes = $state('');
	let groupName = $state('');
	let isSubmitting = $state(false);

	function fmtDuration(sec: number | null): string {
		if (sec == null) return '—';
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}
	function fmtDate(d: string | null): string {
		return d ? new Date(d).toLocaleString() : '—';
	}
	function statusClass(status: string): string {
		switch (status) {
			case 'completed': return 'bg-[var(--color-tron-green)]/15 text-[var(--color-tron-green)]';
			case 'underway': return 'bg-[var(--color-tron-cyan)]/15 text-[var(--color-tron-cyan)]';
			case 'failed': case 'wax_rejected': return 'bg-[var(--color-tron-red)]/15 text-[var(--color-tron-red)]';
			case 'linked': return 'bg-[var(--color-tron-orange)]/15 text-[var(--color-tron-orange)]';
			default: return 'bg-[var(--color-tron-text-secondary)]/15 text-[var(--color-tron-text-secondary)]';
		}
	}

	const ranCount = $derived(data.cartridges.filter((c) => c.ran).length);

	// ---- filtering -----------------------------------------------------------
	// 'all' | a group id | 'ungrouped'. Deliberately a SEPARATE control from the
	// compare-selection chips: one narrows the table, the other picks what to
	// compare, and a single dual-purpose control gets misread.
	let groupFilter = $state<string>('all');

	const visibleCartridges = $derived(
		groupFilter === 'all'
			? data.cartridges
			: groupFilter === 'ungrouped'
				? data.cartridges.filter((c) => !c.group)
				: data.cartridges.filter((c) => c.group?.id === groupFilter)
	);
	const ungroupedCount = $derived(data.cartridges.filter((c) => !c.group).length);

	// ---- multi-select --------------------------------------------------------
	let selected = $state<Set<string>>(new Set());
	const selectedCount = $derived(selected.size);

	// Derived from the VISIBLE rows, not all rows: with a filter active, a
	// select-all driven off data.cartridges would silently check hidden rows.
	const allSelected = $derived(
		visibleCartridges.length > 0 && visibleCartridges.every((c) => selected.has(c.id))
	);

	function toggleOne(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}
	function toggleAll() {
		const next = new Set(selected);
		if (allSelected) for (const c of visibleCartridges) next.delete(c.id);
		else for (const c of visibleCartridges) next.add(c.id);
		selected = next;
	}
	/** Clicking a group pill selects exactly that group's rows. */
	function selectGroup(groupId: string) {
		selected = new Set(data.cartridges.filter((c) => c.group?.id === groupId).map((c) => c.id));
	}

	const selectedIds = $derived([...selected].join(','));
	const analyzeHref = $derived(
		'/validation/optical-confirmation/analyze?ids=' + encodeURIComponent(selectedIds)
	);

	// ---- naming a group ------------------------------------------------------
	let namingOpen = $state(false);
	let newGroupName = $state('');
	let newGroupColor = $state('cyan');
	let isSavingGroup = $state(false);

	/** Which existing groups the current selection would be moved out of. */
	const wouldMove = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const c of data.cartridges) {
			if (selected.has(c.id) && c.group) {
				counts.set(c.group.name, (counts.get(c.group.name) ?? 0) + 1);
			}
		}
		return [...counts.entries()].map(([name, count]) => ({ name, count }));
	});

	// ---- compare selection ---------------------------------------------------
	let comparing = $state<Set<string>>(new Set());
	const comparingCount = $derived(comparing.size);
	const compareHref = $derived(
		'/validation/optical-confirmation/analyze?groups=' +
			encodeURIComponent([...comparing].join(','))
	);

	function toggleCompare(groupId: string) {
		const next = new Set(comparing);
		if (next.has(groupId)) next.delete(groupId);
		else next.add(groupId);
		comparing = next;
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="tron-heading text-2xl font-bold">Optical Confirmation — Assign Validation Cartridges</h1>
		<p class="tron-text-muted mt-1">
			Assign the optical-confirmation assay to a cartridge. The assay's runnable program is
			embedded onto the cartridge so the device can run it on scan.
		</p>
	</div>

	<!-- Assign form -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold">Assign Cartridges</h2>

		<form
			method="POST"
			action="?/assign"
			use:enhance={() => {
				isSubmitting = true;
				return async ({ update }) => { await update({ reset: false }); isSubmitting = false; };
			}}
			class="space-y-6"
		>
			<!-- Fixed assay (only one in use) -->
			<input type="hidden" name="assayId" value={assay?.id ?? ''} />
			<div>
				<div class="tron-text-muted mb-2 block text-sm font-medium">Assay</div>
				{#if assay}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-4 py-3">
						<div class="tron-text-primary font-medium">{assay.name}</div>
						<div class="mt-1 flex flex-wrap gap-4 text-xs text-[var(--color-tron-text-secondary)]">
							<span>Assay ID: <span class="tron-text-primary">{assay.id}</span></span>
							<span>BCODE steps: <span class="tron-text-primary">{assay.bcodeSteps}</span></span>
							<span>Duration: <span class="tron-text-primary">{fmtDuration(assay.duration)}</span></span>
						</div>
					</div>
				{:else}
					<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">
						Optical assay not found.
					</div>
				{/if}
			</div>

			<!-- Barcode + qty + group, all on one page -->
			<div class="grid gap-6 md:grid-cols-2">
				<div class="md:col-span-2">
					<label for="barcodes" class="tron-text-muted mb-2 block text-sm font-medium">
						Scan / paste barcode(s)
					</label>
					<textarea id="barcodes" name="barcodes" bind:value={barcodes} rows="3"
						placeholder="Scan or paste one barcode per line (or comma-separated). Leave blank to generate by quantity."
						class="tron-input w-full rounded-lg px-4 py-3 font-mono text-sm"></textarea>
				</div>

				<div>
					<label for="count" class="tron-text-muted mb-2 block text-sm font-medium">Quantity</label>
					<input id="count" name="count" type="number" min="1" max="200" bind:value={count}
						class="tron-input w-full rounded-lg px-4 py-3" />
					<p class="tron-text-muted mt-1 text-xs">Used only when no barcodes are scanned.</p>
				</div>

				<div>
					<label for="groupName" class="tron-text-muted mb-2 block text-sm font-medium">Group (optional)</label>
					<input id="groupName" name="groupName" type="text" bind:value={groupName}
						placeholder="e.g. group a" class="tron-input w-full rounded-lg px-4 py-3" />
				</div>
			</div>

			{#if form?.success}
				<div class="rounded-lg bg-[var(--color-tron-green)]/10 p-4 text-sm text-[var(--color-tron-green)]">
					Assigned <span class="font-semibold">{form.createdCount}</span> cartridge(s) of
					<span class="font-semibold">{form.assayName}</span> — {form.bcodeSteps} BCODE steps embedded onto each.
					{#if form.skipped && form.skipped.length > 0}
						<div class="mt-1 text-[var(--color-tron-orange)]">
							Skipped {form.skipped.length}: {form.skipped.map((s) => `${s.barcode} (${s.reason})`).join('; ')}
						</div>
					{/if}
				</div>
			{/if}
			{#if form?.error}
				<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{form.error}</div>
			{/if}

			<button type="submit" disabled={!assay || isSubmitting}
				class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 disabled:cursor-not-allowed disabled:opacity-50">
				{isSubmitting ? 'Assigning…' : 'Assign validation cartridges'}
			</button>
		</form>
	</div>

	<!-- Optical test cartridge log -->
	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Optical Test Cartridge Log ({data.cartridges.length})</h2>
			<span class="text-sm text-[var(--color-tron-text-secondary)]">{ranCount} run</span>
		</div>

		<!-- Group-analysis action bar (sticky) -->
		<div class="sticky top-0 z-10 border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-4 py-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex items-center gap-3">
					<span class="text-sm text-[var(--color-tron-text-secondary)]">{selectedCount} selected</span>
					{#if selectedCount > 0}
						<button
							type="button"
							onclick={() => (selected = new Set())}
							class="text-xs text-[var(--color-tron-text-secondary)] underline hover:text-[var(--color-tron-cyan)]"
						>Clear</button>
					{/if}
				</div>
				<div class="flex items-center gap-2">
					<button
						type="button"
						onclick={() => (namingOpen = !namingOpen)}
						disabled={selectedCount < 1}
						class="rounded-lg border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/10 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{namingOpen ? 'Cancel' : 'Save as group'}
					</button>
					<a
						href={analyzeHref}
						class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 {selectedCount <
						1
							? 'pointer-events-none opacity-50'
							: ''}"
						aria-disabled={selectedCount < 1}
					>
						Analyze selected ({selectedCount})
					</a>
				</div>
			</div>

			<!-- Name the current selection as a group -->
			{#if namingOpen && selectedCount > 0}
				<form
					method="POST"
					action="?/saveGroup"
					use:enhance={() => {
						isSavingGroup = true;
						return async ({ result, update }) => {
							await update({ reset: false });
							isSavingGroup = false;
							// Keep the panel open on failure so the name and the 409
							// "add to existing" choice stay in front of the operator.
							if (result.type === 'success') {
								namingOpen = false;
								newGroupName = '';
								selected = new Set();
							}
						};
					}}
					class="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3"
				>
					<input type="hidden" name="cartridgeIds" value={selectedIds} />
					<div class="min-w-[14rem] flex-1">
						<label for="newGroupName" class="tron-text-muted mb-1 block text-xs font-medium">
							Group name
						</label>
						<input
							id="newGroupName"
							name="name"
							type="text"
							required
							bind:value={newGroupName}
							placeholder="e.g. BT-M01-0000-0236 — run 3"
							class="tron-input w-full rounded-lg px-3 py-2 text-sm"
						/>
					</div>
					<div>
						<label for="newGroupColor" class="tron-text-muted mb-1 block text-xs font-medium">Colour</label>
						<select
							id="newGroupColor"
							name="color"
							bind:value={newGroupColor}
							class="tron-input rounded-lg px-3 py-2 text-sm"
						>
							{#each GROUP_COLORS as key}
								<option value={key}>{key}</option>
							{/each}
						</select>
					</div>
					<button
						type="submit"
						disabled={isSavingGroup}
						class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 disabled:opacity-50"
					>
						{isSavingGroup ? 'Saving…' : `Save ${selectedCount} cartridge(s)`}
					</button>

					{#if wouldMove.length > 0}
						<p class="w-full text-xs text-amber-400">
							⚠ A cartridge can only be in one group. {wouldMove
								.map((m) => `${m.count} will move out of "${m.name}"`)
								.join('; ')}.
						</p>
					{/if}
				</form>
			{/if}

			<!-- Group errors, including the 409 "already exists" choice -->
			{#if form?.groupError}
				<div class="mt-3 rounded-lg bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">
					{form.groupError}
					{#if form.existingGroupId}
						<div class="mt-2 flex flex-wrap gap-2">
							<form method="POST" action="?/saveGroup" use:enhance>
								<input type="hidden" name="mode" value="append" />
								<input type="hidden" name="groupId" value={form.existingGroupId} />
								<input type="hidden" name="cartridgeIds" value={selectedIds} />
								<button
									type="submit"
									class="rounded border border-[var(--color-tron-cyan)]/50 px-3 py-1 text-xs font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
								>
									Add these {selectedCount} to "{form.existingGroupName}"
								</button>
							</form>
							<button
								type="button"
								onclick={() => (namingOpen = true)}
								class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
							>
								Use a different name
							</button>
						</div>
					{/if}
				</div>
			{/if}

			{#if form?.groupSaved}
				<div class="mt-3 rounded-lg bg-[var(--color-tron-green)]/10 p-3 text-sm text-[var(--color-tron-green)]">
					Saved group <span class="font-semibold">"{form.groupName}"</span>{#if form.totalCount != null}
						— {form.totalCount} cartridge(s){/if}{#if form.removedCount}
						, removed {form.removedCount}{/if}.
					{#if form.movedFrom && form.movedFrom.length > 0}
						<span class="text-[var(--color-tron-orange)]">
							{form.movedFrom.map((m) => `${m.count} moved from "${m.name}"`).join('; ')}.
						</span>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Groups: pick which to compare, and filter the table -->
		{#if data.groups.length > 0}
			<div class="flex flex-wrap items-center gap-3 border-b border-[var(--color-tron-border)] px-4 py-3">
				<span class="text-xs uppercase tracking-wide text-[var(--color-tron-text-secondary)]">Groups</span>
				<div class="flex flex-wrap items-center gap-2">
					{#each data.groups as g (g.id)}
						<button
							type="button"
							onclick={() => toggleCompare(g.id)}
							title={comparing.has(g.id)
								? `"${g.name}" is included in the comparison — click to remove`
								: `Include "${g.name}" in the comparison`}
							class="rounded-full transition-opacity {comparing.has(g.id)
								? 'ring-1 ring-[var(--color-tron-cyan)]'
								: ''}"
						>
							<GroupPill name={g.name} color={g.color} count={g.count} muted={!comparing.has(g.id)} />
						</button>
					{/each}
				</div>

				<div class="ml-auto flex flex-wrap items-center gap-2">
					<label for="groupFilter" class="text-xs text-[var(--color-tron-text-secondary)]">Show</label>
					<select
						id="groupFilter"
						bind:value={groupFilter}
						class="tron-input rounded-lg px-2 py-1 text-xs"
					>
						<option value="all">All ({data.cartridges.length})</option>
						<option value="ungrouped">Ungrouped ({ungroupedCount})</option>
						{#each data.groups as g (g.id)}
							<option value={g.id}>{g.name} ({g.count})</option>
						{/each}
					</select>
					<a
						href={compareHref}
						class="rounded-lg bg-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-bg-primary)] hover:bg-[var(--color-tron-cyan)]/90 {comparingCount <
						1
							? 'pointer-events-none opacity-50'
							: ''}"
						aria-disabled={comparingCount < 1}
					>
						Compare {comparingCount} group{comparingCount === 1 ? '' : 's'} →
					</a>
				</div>
			</div>
		{/if}
		{#if data.cartridges.length === 0}
			<div class="p-8 text-center">
				<p class="tron-text-muted">No optical test cartridges assigned yet.</p>
			</div>
		{:else if visibleCartridges.length === 0}
			<div class="p-8 text-center">
				<p class="tron-text-muted">
					No cartridges match this filter.
					<button
						type="button"
						onclick={() => (groupFilter = 'all')}
						class="text-[var(--color-tron-cyan)] underline">Show all</button
					>
				</p>
			</div>
		{:else}
			<!-- pb-24 keeps the last rows clear of the floating Ask BIMS widget. -->
			<div class="overflow-x-auto pb-24">
				<table class="w-full text-sm">
					<thead class="text-left text-[var(--color-tron-text-secondary)]">
						<tr class="border-b border-[var(--color-tron-border)]">
							<th class="p-3 font-medium">
								<input
									type="checkbox"
									aria-label="Select all cartridges"
									checked={allSelected}
									onchange={toggleAll}
									class="h-4 w-4 cursor-pointer accent-[var(--color-tron-cyan)]"
								/>
							</th>
							<th class="p-3 font-medium">Barcode</th>
							<th class="p-3 font-medium">Group</th>
							<th class="p-3 font-medium">Assay</th>
							<th class="p-3 font-medium">Status</th>
							<th class="p-3 font-medium">SPU</th>
							<th class="p-3 font-medium">F7/F3 (A/B/C)</th>
							<th class="p-3 font-medium">Result</th>
							<th class="p-3 font-medium">Assigned</th>
							<th class="p-3 font-medium">Completed</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[var(--color-tron-border)]">
						{#each visibleCartridges as c (c.id)}
							<tr class={selected.has(c.id) ? 'bg-[var(--color-tron-cyan)]/5' : ''}>
								<td class="p-3">
									<input
										type="checkbox"
										aria-label={'Select ' + c.barcode}
										checked={selected.has(c.id)}
										onchange={() => toggleOne(c.id)}
										class="h-4 w-4 cursor-pointer accent-[var(--color-tron-cyan)]"
									/>
								</td>
								<td class="p-3 font-mono text-xs text-[var(--color-tron-text-primary)]">
									<a href={'/validation/optical-confirmation/' + c.id} class="hover:text-[var(--color-tron-cyan)] hover:underline">{c.barcode}</a>
								</td>
								<td class="p-3">
									{#if c.group}
										<button
											type="button"
											onclick={() => selectGroup(c.group!.id)}
											title={`Select every cartridge in "${c.group.name}"`}
										>
											<GroupPill name={c.group.name} color={c.group.color} />
										</button>
									{:else}
										<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="p-3">
									{c.assayName ?? '—'}
									{#if !c.assigned}
										<span
											class="ml-2 rounded-full border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] tracking-wide text-[var(--color-tron-text-secondary)]"
											title="Ran the same optical assay but was not assigned through this page — shown as a comparator."
										>COMPARATOR</span>
									{/if}
								</td>
								<td class="p-3">
									<span class="rounded-full px-2 py-1 text-xs font-medium {statusClass(c.status)}">{c.status}</span>
								</td>
								<td class="p-3 font-mono text-xs text-[var(--color-tron-text-secondary)]">{c.spuUdi ?? '—'}</td>
								<td class="p-3 text-xs font-mono">
									{#if c.analysis}
										<span class="inline-flex items-center gap-1">
										<span class="text-[var(--color-tron-text-secondary)]">A:</span>
										<span class="text-[var(--color-tron-cyan)]">{c.analysis.ratioByChannel.A != null ? c.analysis.ratioByChannel.A.toFixed(1) : '—'}</span>
										<span class="text-[var(--color-tron-text-secondary)] ml-2">B:</span>
										<span class="text-[var(--color-tron-cyan)]">{c.analysis.ratioByChannel.B != null ? c.analysis.ratioByChannel.B.toFixed(1) : '—'}</span>
										<span class="text-[var(--color-tron-text-secondary)] ml-2">C:</span>
										<span class="text-[var(--color-tron-cyan)]">{c.analysis.ratioByChannel.C != null ? c.analysis.ratioByChannel.C.toFixed(1) : '—'}</span>
										{#if c.analysis.warning}
											<span
												class="ml-2 text-[var(--color-tron-orange)]"
												title={'Review — cross-channel CV ' + (c.analysis.crossWellCv != null ? c.analysis.crossWellCv.toFixed(0) + '%' : 'n/a')}
											>⚠</span>
										{/if}
										</span>
									{:else}
										<span class="text-[var(--color-tron-text-secondary)]">—</span>
									{/if}
								</td>
								<td class="p-3 text-[var(--color-tron-text-secondary)]">
									{#if c.result}
										{c.result.profileName ?? 'analyzed'}
									{:else if c.ran}
										ran
									{:else}
										—
									{/if}
								</td>
								<td class="p-3 text-xs text-[var(--color-tron-text-secondary)]">{fmtDate(c.assignedAt)}</td>
								<td class="p-3 text-xs text-[var(--color-tron-text-secondary)]">{fmtDate(c.completedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
