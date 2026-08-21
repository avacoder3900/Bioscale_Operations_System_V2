<script lang="ts">
	/**
	 * VALIDATION-06-S3 / S6 — the optical analysis Groups workspace.
	 *
	 * Every form here posts to an action on the cartridge log
	 * (`/validation/optical-confirmation?/…`) rather than to a local action, so the
	 * shipped, audit-logged implementations stay the single source of truth. The
	 * absolute `action` is load-bearing: a bare `?/saveGroup` would look for the
	 * action on THIS route, where it does not exist, and fail with a 404.
	 *
	 * Tables only — no charts anywhere in this feature (PRD §3).
	 */
	import { enhance } from '$app/forms';
	import GroupPill from '$lib/components/validation/optical/GroupPill.svelte';

	/** Where the five group actions actually live. */
	const LOG_ROUTE = '/validation/optical-confirmation';
	const GROUPS_ROUTE = '/validation/optical-confirmation/groups';

	/**
	 * Palette KEYS, mirrored from `$lib/server/optical-constants` — a client component
	 * must not import from `$lib/server/**`, so the list is restated here (the
	 * established convention on these pages). Red is excluded: it reads as an error.
	 */
	const GROUP_COLORS = ['cyan', 'green', 'purple', 'yellow', 'orange', 'blue'];

	interface Props {
		data: {
			groups: Array<{
				id: string;
				name: string;
				description: string | null;
				color: string;
				count: number;
				createdAt: string | null;
			}>;
			candidates: Array<{
				id: string;
				barcode: string;
				spuUdi: string | null;
				ratioByChannel: { A: number | null; B: number | null; C: number | null };
				runDate: string | null;
			}>;
		};
		form: {
			groupSaved?: boolean;
			groupArchived?: boolean;
			groupError?: string;
			groupId?: string;
			groupName?: string;
			addedCount?: number;
			totalCount?: number;
			removedCount?: number;
			movedFrom?: Array<{ name: string; count: number }>;
			existingGroupId?: string;
			existingGroupName?: string;
		} | null;
	}

	let { data, form }: Props = $props();

	// Which panel a form response belongs to. Without this, a rename clash and a
	// create clash would both light up every error slot on the page at once.
	let formScope = $state<'create' | 'rename' | 'archive' | null>(null);
	let isSubmitting = $state(false);

	// ---- new group panel -----------------------------------------------------
	let newOpen = $state(false);
	let newName = $state('');
	let newDescription = $state('');
	let newColor = $state('cyan');
	let search = $state('');
	let picked = $state<Set<string>>(new Set());

	const pickedCount = $derived(picked.size);
	const pickedIds = $derived([...picked].join(','));

	const filteredCandidates = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data.candidates;
		return data.candidates.filter(
			(c) =>
				c.barcode.toLowerCase().includes(q) || (c.spuUdi ?? '').toLowerCase().includes(q)
		);
	});

	// Select-all works on what is VISIBLE: driving it off the full candidate list
	// would silently check rows the operator has filtered away.
	const allShownPicked = $derived(
		filteredCandidates.length > 0 && filteredCandidates.every((c) => picked.has(c.id))
	);

	function togglePick(id: string) {
		const next = new Set(picked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		picked = next;
	}
	function toggleAllShown() {
		const next = new Set(picked);
		if (allShownPicked) for (const c of filteredCandidates) next.delete(c.id);
		else for (const c of filteredCandidates) next.add(c.id);
		picked = next;
	}

	// ---- rename / archive ----------------------------------------------------
	let renamingId = $state<string | null>(null);
	let renameName = $state('');
	let renameDescription = $state('');
	let renameColor = $state('cyan');
	let archivingId = $state<string | null>(null);

	function openRename(g: Props['data']['groups'][number]) {
		archivingId = null;
		renamingId = renamingId === g.id ? null : g.id;
		renameName = g.name;
		renameDescription = g.description ?? '';
		renameColor = g.color;
	}

	// ---- compare selection ---------------------------------------------------
	// An ORDERED list, not a Set: checking a third group has to evict the oldest, and
	// "oldest" only exists if insertion order is kept. Capping at two means the
	// control can never sit in a state that has no valid comparison to offer.
	let compareSel = $state<string[]>([]);

	function toggleCompare(id: string) {
		if (compareSel.includes(id)) {
			compareSel = compareSel.filter((x) => x !== id);
			return;
		}
		compareSel = [...compareSel, id].slice(-2);
	}

	const compareA = $derived(data.groups.find((g) => g.id === compareSel[0]) ?? null);
	const compareB = $derived(data.groups.find((g) => g.id === compareSel[1]) ?? null);
	const compareHref = $derived(
		compareA && compareB
			? `${GROUPS_ROUTE}/compare?a=${encodeURIComponent(compareA.id)}&b=${encodeURIComponent(compareB.id)}`
			: ''
	);

	// ---- formatting ----------------------------------------------------------
	function fmtDate(d: string | null): string {
		return d ? new Date(d).toLocaleDateString() : '—';
	}
	function fmtRatio(v: number | null): string {
		return v != null ? v.toFixed(1) : '—';
	}
</script>

<div class="space-y-6 pb-28">
	<!-- Header -->
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Optical Confirmation — Analysis Groups</h1>
			<p class="tron-text-muted mt-1">
				Build a cohort from cartridges that have already run, read its numbers, or put two
				cohorts side by side. Raw F7/F3 throughout — no calibration factors are applied.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<a
				href={LOG_ROUTE}
				class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-all hover:text-[var(--color-tron-cyan)]"
			>
				← Cartridge log
			</a>
			<button
				type="button"
				onclick={() => (newOpen = !newOpen)}
				class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90"
			>
				{newOpen ? 'Cancel' : '+ New group'}
			</button>
		</div>
	</div>

	<!-- Save / archive confirmations -->
	{#if form?.groupSaved && !form?.groupError}
		<div class="rounded-lg bg-[var(--color-tron-green)]/10 p-3 text-sm text-[var(--color-tron-green)]">
			Saved group <span class="font-semibold">"{form.groupName}"</span>{#if form.totalCount != null}
				— {form.totalCount} cartridge(s){/if}.
			{#if form.movedFrom && form.movedFrom.length > 0}
				<span class="text-[var(--color-tron-orange)]">
					{form.movedFrom.map((m) => `${m.count} moved from "${m.name}"`).join('; ')}.
				</span>
			{/if}
		</div>
	{/if}
	{#if form?.groupArchived}
		<div class="rounded-lg bg-[var(--color-tron-green)]/10 p-3 text-sm text-[var(--color-tron-green)]">
			Archived <span class="font-semibold">"{form.groupName}"</span> — hidden from this list and
			from the log, but nothing was deleted.
		</div>
	{/if}
	{#if form?.groupError && formScope === 'archive'}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">
			{form.groupError}
		</div>
	{/if}

	<!-- ---------------- New group panel ---------------- -->
	{#if newOpen}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-1 text-lg font-semibold">New analysis group</h2>
			<p class="tron-text-muted mb-4 text-sm">
				Only cartridges that have already run are offered — a cartridge with no readings
				yields no statistic, so it could never contribute to the group's numbers.
			</p>

			<form
				method="POST"
				action={LOG_ROUTE + '?/saveGroup'}
				use:enhance={() => {
					formScope = 'create';
					isSubmitting = true;
					return async ({ result, update }) => {
						await update({ reset: false });
						isSubmitting = false;
						// Stay open on failure so the name and the 409 "add to existing"
						// choice remain in front of the operator with the selection intact.
						if (result.type === 'success') {
							newOpen = false;
							newName = '';
							newDescription = '';
							picked = new Set();
							search = '';
						}
					};
				}}
				class="space-y-4"
			>
				<input type="hidden" name="cartridgeIds" value={pickedIds} />

				<div class="grid gap-4 md:grid-cols-[2fr_2fr_1fr]">
					<div>
						<label for="newName" class="tron-text-muted mb-1 block text-xs font-medium">
							Group name
						</label>
						<input
							id="newName"
							name="name"
							type="text"
							required
							bind:value={newName}
							placeholder="e.g. BT-M01-0000-0236 — run 3"
							class="tron-input w-full rounded-lg px-3 py-2 text-sm"
						/>
					</div>
					<div>
						<label for="newDescription" class="tron-text-muted mb-1 block text-xs font-medium">
							Description (optional)
						</label>
						<input
							id="newDescription"
							name="description"
							type="text"
							bind:value={newDescription}
							placeholder="What this cohort is for"
							class="tron-input w-full rounded-lg px-3 py-2 text-sm"
						/>
					</div>
					<div>
						<label for="newColor" class="tron-text-muted mb-1 block text-xs font-medium">Colour</label>
						<select
							id="newColor"
							name="color"
							bind:value={newColor}
							class="tron-input w-full rounded-lg px-3 py-2 text-sm"
						>
							{#each GROUP_COLORS as key (key)}
								<option value={key}>{key}</option>
							{/each}
						</select>
					</div>
				</div>

				<!-- Cartridge picker -->
				<div class="rounded-lg border border-[var(--color-tron-border)]">
					<div class="flex flex-wrap items-center gap-3 border-b border-[var(--color-tron-border)] p-3">
						<input
							type="search"
							bind:value={search}
							placeholder="Search barcode or SPU…"
							aria-label="Search cartridges by barcode or SPU"
							class="tron-input min-w-[14rem] flex-1 rounded-lg px-3 py-2 text-sm"
						/>
						<span class="text-sm font-semibold text-[var(--color-tron-cyan)]">
							{pickedCount} selected
						</span>
						<span class="text-xs text-[var(--color-tron-text-secondary)]">
							{filteredCandidates.length} of {data.candidates.length} shown
						</span>
						{#if pickedCount > 0}
							<button
								type="button"
								onclick={() => (picked = new Set())}
								class="text-xs text-[var(--color-tron-text-secondary)] underline hover:text-[var(--color-tron-cyan)]"
							>
								Clear
							</button>
						{/if}
					</div>

					{#if data.candidates.length === 0}
						<p class="tron-text-muted p-6 text-center text-sm">
							No optical cartridge has readings yet, so there is nothing to group.
						</p>
					{:else if filteredCandidates.length === 0}
						<p class="tron-text-muted p-6 text-center text-sm">
							No cartridge matches “{search}”.
						</p>
					{:else}
						<div class="max-h-80 overflow-y-auto">
							<table class="w-full text-sm">
								<thead
									class="sticky top-0 bg-[var(--color-tron-bg-secondary)] text-left text-[var(--color-tron-text-secondary)]"
								>
									<tr class="border-b border-[var(--color-tron-border)]">
										<th class="p-2 font-medium">
											<input
												type="checkbox"
												aria-label="Select all shown cartridges"
												checked={allShownPicked}
												onchange={toggleAllShown}
												class="h-4 w-4 cursor-pointer accent-[var(--color-tron-cyan)]"
											/>
										</th>
										<th class="p-2 font-medium">Barcode</th>
										<th class="p-2 font-medium">SPU</th>
										<th class="p-2 font-medium">A/B/C F7/F3</th>
										<th class="p-2 font-medium">Run date</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-[var(--color-tron-border)]">
									{#each filteredCandidates as c (c.id)}
										<tr class={picked.has(c.id) ? 'bg-[var(--color-tron-cyan)]/5' : ''}>
											<td class="p-2">
												<input
													type="checkbox"
													aria-label={'Select ' + c.barcode}
													checked={picked.has(c.id)}
													onchange={() => togglePick(c.id)}
													class="h-4 w-4 cursor-pointer accent-[var(--color-tron-cyan)]"
												/>
											</td>
											<td class="p-2 font-mono text-xs text-[var(--color-tron-text-primary)]">
												{c.barcode}
											</td>
											<td class="p-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">
												{c.spuUdi ?? '—'}
											</td>
											<td class="p-2 font-mono text-xs">
												<span class="text-[var(--color-tron-cyan)]">
													{fmtRatio(c.ratioByChannel.A)} / {fmtRatio(c.ratioByChannel.B)} / {fmtRatio(
														c.ratioByChannel.C
													)}
												</span>
											</td>
											<td class="p-2 text-xs text-[var(--color-tron-text-secondary)]">
												{fmtDate(c.runDate)}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</div>

				<div class="flex items-center gap-3">
					<button
						type="submit"
						disabled={isSubmitting || pickedCount === 0}
						class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isSubmitting ? 'Saving…' : `Create group with ${pickedCount} cartridge(s)`}
					</button>
					{#if pickedCount === 0}
						<span class="text-xs text-[var(--color-tron-text-secondary)]">
							Select at least one cartridge.
						</span>
					{/if}
					<p class="ml-auto text-xs text-amber-400">
						⚠ A cartridge belongs to exactly one group — adding it here removes it from any
						other.
					</p>
				</div>
			</form>

			<!-- Create errors, including the 409 "that name already exists" choice.
			     This lives OUTSIDE the create form on purpose: the append path is its own
			     POST (mode=append + groupId) and HTML forbids nesting one form in another. -->
			{#if form?.groupError && formScope === 'create'}
				<div class="mt-4 rounded-lg bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]">
					{form.groupError}
					{#if form.existingGroupId}
						<div class="mt-2 flex flex-wrap items-center gap-2">
							<form
								method="POST"
								action={LOG_ROUTE + '?/saveGroup'}
								use:enhance={() => {
									formScope = 'create';
									isSubmitting = true;
									return async ({ result, update }) => {
										await update({ reset: false });
										isSubmitting = false;
										if (result.type === 'success') {
											newOpen = false;
											newName = '';
											newDescription = '';
											picked = new Set();
											search = '';
										}
									};
								}}
							>
								<input type="hidden" name="mode" value="append" />
								<input type="hidden" name="groupId" value={form.existingGroupId} />
								<input type="hidden" name="cartridgeIds" value={pickedIds} />
								<button
									type="submit"
									disabled={isSubmitting || pickedCount === 0}
									class="rounded border border-[var(--color-tron-cyan)]/50 px-3 py-1 text-xs font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-50"
								>
									Add these {pickedCount} to "{form.existingGroupName}"
								</button>
							</form>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								…or change the name above and save again.
							</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- ---------------- Group list ---------------- -->
	{#if data.groups.length === 0}
		<div class="tron-card p-10 text-center">
			<p class="tron-text-primary font-medium">No analysis groups yet.</p>
			<p class="tron-text-muted mx-auto mt-2 max-w-lg text-sm">
				Create one above from cartridges that have already run, or check rows on the cartridge
				log and use “Save as group” there.
			</p>
			<a
				href={LOG_ROUTE}
				class="mt-4 inline-block rounded-lg border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] transition-all hover:bg-[var(--color-tron-cyan)]/10"
			>
				Go to the cartridge log →
			</a>
		</div>
	{:else}
		<div class="space-y-3">
			{#each data.groups as g (g.id)}
				<div class="tron-card p-4">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="flex min-w-0 items-start gap-3">
							<input
								type="checkbox"
								aria-label={'Select "' + g.name + '" for comparison'}
								title="Pick two groups to compare"
								checked={compareSel.includes(g.id)}
								onchange={() => toggleCompare(g.id)}
								class="mt-1 h-4 w-4 cursor-pointer accent-[var(--color-tron-cyan)]"
							/>
							<div class="min-w-0">
								<div class="flex flex-wrap items-center gap-2">
									<GroupPill name={g.name} color={g.color} />
									<span class="text-sm text-[var(--color-tron-text-primary)]">
										{g.count} cartridge{g.count === 1 ? '' : 's'}
									</span>
								</div>
								<p class="tron-text-muted mt-1 text-sm">
									{g.description ?? 'No description.'}
								</p>
								<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
									Created {fmtDate(g.createdAt)}
								</p>
							</div>
						</div>

						<div class="flex flex-wrap items-center gap-2">
							<a
								href={GROUPS_ROUTE + '/' + g.id}
								class="rounded-lg bg-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90"
							>
								Analyze
							</a>
							<button
								type="button"
								onclick={() => openRename(g)}
								class="rounded-lg border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-all hover:text-[var(--color-tron-cyan)]"
							>
								{renamingId === g.id ? 'Cancel' : 'Rename'}
							</button>
							<button
								type="button"
								onclick={() => {
									renamingId = null;
									archivingId = archivingId === g.id ? null : g.id;
								}}
								class="rounded-lg border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] transition-all hover:text-[var(--color-tron-red)]"
							>
								Archive
							</button>
						</div>
					</div>

					<!-- Inline rename -->
					{#if renamingId === g.id}
						<form
							method="POST"
							action={LOG_ROUTE + '?/renameGroup'}
							use:enhance={() => {
								formScope = 'rename';
								isSubmitting = true;
								return async ({ result, update }) => {
									await update({ reset: false });
									isSubmitting = false;
									// A 409 name clash must stay on screen next to the field
									// that caused it, so only a success closes the panel.
									if (result.type === 'success') renamingId = null;
								};
							}}
							class="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3"
						>
							<input type="hidden" name="groupId" value={g.id} />
							<div class="min-w-[12rem] flex-1">
								<label for={'renameName-' + g.id} class="tron-text-muted mb-1 block text-xs font-medium">
									Name
								</label>
								<input
									id={'renameName-' + g.id}
									name="name"
									type="text"
									required
									bind:value={renameName}
									class="tron-input w-full rounded-lg px-3 py-2 text-sm"
								/>
							</div>
							<div class="min-w-[12rem] flex-1">
								<label
									for={'renameDescription-' + g.id}
									class="tron-text-muted mb-1 block text-xs font-medium"
								>
									Description
								</label>
								<input
									id={'renameDescription-' + g.id}
									name="description"
									type="text"
									bind:value={renameDescription}
									class="tron-input w-full rounded-lg px-3 py-2 text-sm"
								/>
							</div>
							<div>
								<label for={'renameColor-' + g.id} class="tron-text-muted mb-1 block text-xs font-medium">
									Colour
								</label>
								<select
									id={'renameColor-' + g.id}
									name="color"
									bind:value={renameColor}
									class="tron-input rounded-lg px-3 py-2 text-sm"
								>
									{#each GROUP_COLORS as key (key)}
										<option value={key}>{key}</option>
									{/each}
								</select>
							</div>
							<button
								type="submit"
								disabled={isSubmitting}
								class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 disabled:opacity-50"
							>
								Save
							</button>
							{#if form?.groupError && formScope === 'rename'}
								<p class="w-full text-xs text-[var(--color-tron-red)]">{form.groupError}</p>
							{/if}
						</form>
					{/if}

					<!-- Archive confirm. Archiving hides the group everywhere, so it gets a
					     deliberate second step rather than a single click. -->
					{#if archivingId === g.id}
						<form
							method="POST"
							action={LOG_ROUTE + '?/archiveGroup'}
							use:enhance={() => {
								formScope = 'archive';
								isSubmitting = true;
								return async ({ update }) => {
									await update({ reset: false });
									isSubmitting = false;
									archivingId = null;
								};
							}}
							class="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-tron-red)]/40 bg-[var(--color-tron-red)]/5 p-3"
						>
							<input type="hidden" name="groupId" value={g.id} />
							<p class="flex-1 text-sm text-[var(--color-tron-text-primary)]">
								Archive <span class="font-semibold">"{g.name}"</span>? It disappears from this
								workspace and from the log's group chips. Nothing is deleted — its
								{g.count} cartridge{g.count === 1 ? '' : 's'} and the group record stay in the
								database.
							</p>
							<button
								type="submit"
								disabled={isSubmitting}
								class="rounded-lg bg-[var(--color-tron-red)] px-4 py-2 text-xs font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-red)]/90 disabled:opacity-50"
							>
								{isSubmitting ? 'Archiving…' : 'Yes, archive'}
							</button>
							<button
								type="button"
								onclick={() => (archivingId = null)}
								class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
							>
								Cancel
							</button>
						</form>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Sticky compare bar — only ever offered with exactly two groups picked. -->
		{#if compareSel.length > 0}
			<div class="sticky bottom-4 z-20">
				<div
					class="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-bg-secondary)] p-3 shadow-lg"
				>
					{#if compareA && compareB}
						<span class="flex flex-wrap items-center gap-2 text-sm text-[var(--color-tron-text-primary)]">
							Compare
							<GroupPill name={compareA.name} color={compareA.color} count={compareA.count} />
							vs
							<GroupPill name={compareB.name} color={compareB.color} count={compareB.count} />
						</span>
						<a
							href={compareHref}
							class="ml-auto rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90"
						>
							Compare "{compareA.name}" vs "{compareB.name}" →
						</a>
					{:else}
						<span class="text-sm text-[var(--color-tron-text-secondary)]">
							Pick one more group to compare.
						</span>
					{/if}
					<button
						type="button"
						onclick={() => (compareSel = [])}
						class="text-xs text-[var(--color-tron-text-secondary)] underline hover:text-[var(--color-tron-cyan)]"
					>
						Clear
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>
