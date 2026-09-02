<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';
	import SpuStatusBadge from '$lib/components/spu/SpuStatusBadge.svelte';
	import ScanInput from '$lib/components/assembly/ScanInput.svelte';

	let { data, form } = $props();

	/** The code the failed scan actually saw; `{#if}` narrowing won't reach the body. */
	const scanErrorCode = $derived((form as { scanned?: string } | null)?.scanned ?? null);

	let showOpenModal = $state(false);
	let submitting = $state(false);
	/** Row currently expanded into its detail panel. */
	let selectedId = $state<string | null>(null);

	/**
	 * ScanInput grabs focus back on every blur, which is right for a bench
	 * scanner and wrong for the lot-number and note fields on the same page.
	 * Pause it whenever focus is sitting in a real field.
	 */
	let scanPaused = $state(false);
	let scanForm: HTMLFormElement | undefined = $state();
	let scannedCode = $state('');

	const typeLabels: Record<string, string> = {
		inspection: 'Inspection',
		calibration: 'Calibration',
		repair: 'Repair',
		'part-replacement': 'Part replacement',
		other: 'Other'
	};

	const priorityLabels: Record<string, string> = {
		low: 'Low',
		normal: 'Normal',
		high: 'High'
	};

	const changeCategories = ['adjustment', 'cleaning', 'rework', 'configuration', 'other'];

	// --- Group tasks ------------------------------------------------------
	let showGroupModal = $state(false);
	/** Group whose "add units" panel is open. */
	let addingToGroup = $state<string | null>(null);
	/** Group currently expanded on the board. */
	let openGroupId = $state<string | null>(null);
	/** SPUs ticked in the create-group modal. */
	let groupPicks = $state<string[]>([]);
	let groupPickQuery = $state('');

	const outcomeLabels: Record<string, string> = {
		ok: 'OK',
		issue: 'Issue',
		rework: 'Rework',
		blocked: 'Blocked'
	};

	function outcomeVariant(outcome: string | null): 'success' | 'error' | 'warning' | 'neutral' {
		if (outcome === 'ok') return 'success';
		if (outcome === 'rework') return 'warning';
		if (outcome === 'issue' || outcome === 'blocked') return 'error';
		return 'neutral';
	}

	function toggleGroup(id: string) {
		openGroupId = openGroupId === id ? null : id;
	}

	function togglePick(id: string) {
		groupPicks = groupPicks.includes(id)
			? groupPicks.filter((x) => x !== id)
			: [...groupPicks, id];
	}

	/** SPUs offered in the create-group picker, narrowed by the type-ahead. */
	const groupPickOptions = $derived.by(() => {
		const needle = groupPickQuery.trim().toLowerCase();
		const all = data.groupCandidates as any[];
		if (!needle) return all.slice(0, 60);
		return all
			.filter((sp) =>
				[sp.shortId, sp.udi, sp.barcode, sp.customer, sp.status]
					.filter(Boolean)
					.some((v: string) => String(v).toLowerCase().includes(needle))
			)
			.slice(0, 60);
	});

	// Reset the group modal once a create succeeds, but leave errors on screen.
	$effect(() => {
		if (form?.success && form?.groupCreated) {
			showGroupModal = false;
			groupPicks = [];
			groupPickQuery = '';
		}
		if (form?.success && form?.groupUpdated) addingToGroup = null;
	});

	function priorityVariant(priority: string): 'error' | 'info' | 'neutral' {
		if (priority === 'high') return 'error';
		if (priority === 'normal') return 'info';
		return 'neutral';
	}

	function rowKey(row: { recordId: string | null; spuId: string }): string {
		return row.recordId ?? `spu:${row.spuId}`;
	}

	function toggle(row: { recordId: string | null; spuId: string }) {
		const key = rowKey(row);
		selectedId = selectedId === key ? null : key;
	}

	function formatDate(value: string | null): string {
		if (!value) return '—';
		return new Date(value).toLocaleDateString();
	}

	function formatDateTime(value: string | null): string {
		if (!value) return '—';
		return new Date(value).toLocaleString();
	}

	function ageLabel(days: number): string {
		if (days <= 0) return 'today';
		if (days === 1) return '1 day';
		return `${days} days`;
	}

	function submitHandler() {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
		};
	}

	/**
	 * A scan posts straight to the server, which either resumes the unit's open
	 * job or opens a new one. The tech never touches a dialog to get a unit
	 * onto the board.
	 */
	function handleScan(value: string) {
		scannedCode = value;
		queueMicrotask(() => scanForm?.requestSubmit());
	}

	// Whatever the server just acted on becomes the open panel, so a scan lands
	// the tech directly in the job they are about to work on.
	$effect(() => {
		const id = (form as { focusRecordId?: string } | null)?.focusRecordId;
		if (id) selectedId = id;
	});

	function isTextField(el: EventTarget | Element | null): boolean {
		const node = el as HTMLElement | null;
		if (!node || node.id === 'scan-input') return false;
		return ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName);
	}

	function onFocusIn(event: FocusEvent) {
		scanPaused = isTextField(event.target);
	}

	function onFocusOut() {
		// Let focus settle before deciding — blur fires before the next focus.
		setTimeout(() => {
			scanPaused = isTextField(document.activeElement);
		}, 0);
	}

	// Close the modal once an open succeeds, but leave errors on screen.
	$effect(() => {
		if ((form as { opened?: boolean } | null)?.opened) showOpenModal = false;
	});
</script>

<svelte:head>
	<title>Servicing — SPU Manufacturing</title>
</svelte:head>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="space-y-6" onfocusin={onFocusIn} onfocusout={onFocusOut}>
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h2 class="tron-text-primary text-2xl font-bold">Servicing</h2>
			<p class="tron-text-muted text-sm">
				Scan a unit to open or resume its job. Everything about that job lives in one panel.
			</p>
		</div>
		<TronButton variant="ghost" onclick={() => (showGroupModal = true)}>
			+ New group task
		</TronButton>
		<TronButton variant="ghost" onclick={() => (showOpenModal = true)}>
			Start job without a scan
		</TronButton>
	</div>

	<!--
		Scan bar. This is the primary control on the page, so it sits above the
		summary rather than below it, and it keeps focus unless a field steals it.
	-->
	<TronCard class="border-[var(--color-tron-cyan)]">
		<form
			method="POST"
			action="?/scan"
			bind:this={scanForm}
			use:enhance={submitHandler}
			class="space-y-3"
		>
			<input type="hidden" name="code" value={scannedCode} />
			<ScanInput
				label="Scan SPU barcode or UDI"
				placeholder="Scan to open or resume a service job..."
				onScan={handleScan}
				disabled={scanPaused || submitting}
			/>
		</form>

		{#if scanPaused}
			<p class="tron-text-muted mt-2 text-xs">
				Scanner paused while you type. Click back on the scan field to resume.
			</p>
		{/if}

		{#if form?.error}
			<p class="mt-3 text-sm text-[var(--color-tron-red)]">
				{form.error}{#if scanErrorCode}&nbsp;<span class="tron-text-muted">({scanErrorCode})</span>{/if}
			</p>
		{:else if form?.message}
			<p class="mt-3 text-sm text-[var(--color-tron-cyan)]">{form.message}</p>
		{/if}
	</TronCard>

	<!-- Filters -->
	<TronCard>
		<form method="GET" class="grid gap-3 sm:grid-cols-4">
			<div class="sm:col-span-2">
				<label for="svc-q" class="tron-label">Search</label>
				<input
					id="svc-q"
					name="q"
					class="tron-input"
					value={data.filters.q}
					placeholder="SPU, UDI, barcode, customer, location..."
				/>
			</div>
			<div>
				<label for="svc-loc" class="tron-label">Location</label>
				<select id="svc-loc" name="location" class="tron-select" value={data.filters.location}>
					<option value="">All locations</option>
					<option value="__unassigned__">Unassigned</option>
					{#each data.knownLocations as loc (loc)}
						<option value={loc}>{loc}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="svc-type" class="tron-label">Type</label>
				<select id="svc-type" name="type" class="tron-select" value={data.filters.type}>
					<option value="">All types</option>
					{#each data.serviceTypes as type (type)}
						<option value={type}>{typeLabels[type] ?? type}</option>
					{/each}
				</select>
			</div>
			<div class="sm:col-span-4">
				<TronButton type="submit" size="sm">Apply</TronButton>
				{#if data.filters.q || data.filters.location || data.filters.type}
					<a href="/spu/mfg/servicing" class="tron-text-muted ml-3 text-xs hover:underline">
						Clear filters
					</a>
				{/if}
			</div>
		</form>
	</TronCard>

	<!-- Group tasks: the same job running across several units. -->
	{#if data.groups.length > 0}
		<div class="space-y-3">
			<h3 class="tron-text-muted text-sm font-bold uppercase">Group tasks</h3>
			{#each data.groups as group (group.id)}
				{@const expanded = openGroupId === group.id}
				<TronCard class={expanded ? 'border-[var(--color-tron-cyan)]' : ''}>
					<button
						type="button"
						class="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-left"
						onclick={() => toggleGroup(group.id)}
						aria-expanded={expanded}
					>
						<svg
							class="h-4 w-4 shrink-0 text-[var(--color-tron-text-secondary)] transition-transform {expanded
								? 'rotate-90'
								: ''}"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
						</svg>

						<span class="tron-text-primary font-bold">{group.name}</span>

						<TronBadge variant="neutral">{typeLabels[group.serviceType] ?? group.serviceType}</TronBadge>
						<TronBadge variant={priorityVariant(group.priority)}>
							{priorityLabels[group.priority] ?? group.priority}
						</TronBadge>

						<span class="tron-text-secondary text-sm">
							{group.memberCount}
							{group.memberCount === 1 ? 'unit' : 'units'}
						</span>
						<span class="tron-text-muted text-sm">
							{group.touchedCount}/{group.memberCount} with findings
						</span>
						{#if group.needsAttentionCount > 0}
							<TronBadge variant="error">{group.needsAttentionCount} need attention</TronBadge>
						{/if}
						<span class="tron-text-muted ml-auto text-xs">open {ageLabel(group.daysOpen)}</span>
					</button>

					{#if expanded}
						<div class="mt-4 space-y-4 border-t border-[var(--color-tron-border)] pt-4">
							{#if group.description}
								<p class="tron-text-secondary text-sm italic">{group.description}</p>
							{/if}
							<p class="tron-text-muted text-xs">
								Opened {formatDate(group.openedAt)}{#if group.openedBy} by {group.openedBy}{/if}
								{#if group.hiddenCount > 0}
									· <span class="text-[var(--color-tron-orange)]">
										{group.hiddenCount} more unit(s) hidden by the current filters
									</span>
								{/if}
							</p>

							<!-- Group notes: apply to the whole task, not one unit. -->
							<div class="rounded border border-[var(--color-tron-border)] p-4">
								<h4 class="tron-text-primary mb-3 text-sm font-bold uppercase">Group notes</h4>
								{#if group.notes.length > 0}
									<ul class="mb-3 space-y-2">
										{#each group.notes as note (note.id)}
											<li class="border-l-2 border-[var(--color-tron-cyan)] pl-3 text-sm">
												<p class="tron-text-secondary">{note.text}</p>
												<p class="tron-text-muted text-xs">
													{note.addedBy ?? 'unknown'} · {formatDateTime(note.addedAt)}
												</p>
											</li>
										{/each}
									</ul>
								{:else}
									<p class="tron-text-muted mb-3 text-sm italic">
										Nothing recorded for the task as a whole yet.
									</p>
								{/if}
								<form
									method="POST"
									action="?/addGroupNote"
									use:enhance={submitHandler}
									class="flex gap-2"
								>
									<input type="hidden" name="groupId" value={group.id} />
									<input
										name="text"
										type="text"
										class="tron-input flex-1"
										placeholder="Note for every unit in this task..."
										required
										style="min-height: 44px;"
									/>
									<TronButton type="submit" disabled={submitting} style="min-height: 44px;">
										Add
									</TronButton>
								</form>
							</div>

							<!-- Per-unit findings -->
							<div class="space-y-3">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<h4 class="tron-text-primary text-sm font-bold uppercase">Units</h4>
									<TronButton
										onclick={() => (addingToGroup = addingToGroup === group.id ? null : group.id)}
										style="min-height: 40px;"
									>
										{addingToGroup === group.id ? 'Cancel' : '+ Add units'}
									</TronButton>
								</div>

								{#if addingToGroup === group.id}
									<form
										method="POST"
										action="?/addToGroup"
										use:enhance={submitHandler}
										class="rounded border border-[var(--color-tron-cyan)] p-4"
									>
										<input type="hidden" name="groupId" value={group.id} />
										<label for="add-units-{group.id}" class="tron-label">
											Add SPUs to this task
										</label>
										<select
											id="add-units-{group.id}"
											name="spuIds"
											multiple
											size="6"
											class="tron-select w-full"
										>
											{#each data.groupCandidates as spu (spu.id)}
												<option value={spu.id}>
													{spu.shortId} · {spu.status}{spu.inServicing ? ' · in servicing' : ''}{spu.customer
														? ` · ${spu.customer}`
														: ''}
												</option>
											{/each}
										</select>
										<p class="tron-text-muted mt-1 text-xs">
											Ctrl/Cmd-click to pick several. Units not already in servicing are pulled in.
										</p>
										<div class="mt-3">
											<label for="add-units-loc-{group.id}" class="tron-label">
												Where are they? (optional)
											</label>
											<input
												id="add-units-loc-{group.id}"
												name="location"
												type="text"
												list="known-locations"
												class="tron-input w-full"
												placeholder="e.g. Bench 3, Lab A"
												style="min-height: 44px;"
											/>
										</div>
										<div class="mt-3">
											<TronButton
												type="submit"
												variant="primary"
												disabled={submitting}
												style="min-height: 44px;"
											>
												Add to task
											</TronButton>
										</div>
									</form>
								{/if}

								{#if group.members.length === 0}
									<p class="tron-text-muted py-4 text-center text-sm">
										No units match the current filters.
									</p>
								{/if}

								{#each group.members as member (member.recordId)}
									<div
										id="svc-row-{member.recordId}"
										class="rounded border border-[var(--color-tron-border)] p-4"
									>
										<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
											<a
												href="/spu/{member.spuId}"
												class="tron-text-primary font-bold hover:text-[var(--color-tron-cyan)]"
											>
												{member.shortId}
											</a>
											<span
												class="flex items-center gap-1.5 text-sm"
												style="color: {member.location
													? 'var(--color-tron-cyan)'
													: 'var(--color-tron-text-secondary)'};"
											>
												<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
													/>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
													/>
												</svg>
												{member.location || 'Location not set'}
											</span>
											{#if member.latestOutcome}
												<TronBadge variant={outcomeVariant(member.latestOutcome)}>
													{outcomeLabels[member.latestOutcome] ?? member.latestOutcome}
												</TronBadge>
											{:else}
												<TronBadge variant="neutral">No findings yet</TronBadge>
											{/if}
											<form
												method="POST"
												action="?/removeFromGroup"
												use:enhance={submitHandler}
												class="ml-auto"
											>
												<input type="hidden" name="recordId" value={member.recordId} />
												<button
													type="submit"
													class="tron-text-muted text-xs hover:text-[var(--color-tron-red)]"
													disabled={submitting}
												>
													Remove from task
												</button>
											</form>
										</div>

										{#if member.findings.length > 0}
											<ul class="mt-3 space-y-2">
												{#each member.findings as finding (finding.id)}
													<li class="flex gap-2 text-sm">
														<TronBadge variant={outcomeVariant(finding.outcome)}>
															{outcomeLabels[finding.outcome] ?? finding.outcome}
														</TronBadge>
														<span class="min-w-0 flex-1">
															<span class="tron-text-secondary">{finding.text}</span>
															<span class="tron-text-muted text-xs">
																· {finding.addedBy ?? 'unknown'} · {formatDateTime(finding.addedAt)}
															</span>
														</span>
													</li>
												{/each}
											</ul>
										{/if}

										<form
											method="POST"
											action="?/addFinding"
											use:enhance={submitHandler}
											class="mt-3 flex flex-wrap gap-2"
										>
											<input type="hidden" name="recordId" value={member.recordId} />
											<input
												name="text"
												type="text"
												class="tron-input min-w-[12rem] flex-1"
												placeholder="What did you find on this unit?"
												required
												style="min-height: 44px;"
											/>
											<select name="outcome" class="tron-select" style="min-height: 44px;">
												{#each data.findingOutcomes as outcome (outcome)}
													<option value={outcome}>{outcomeLabels[outcome] ?? outcome}</option>
												{/each}
											</select>
											<TronButton type="submit" disabled={submitting} style="min-height: 44px;">
												Record
											</TronButton>
										</form>

										<!-- Complete this one unit without waiting for the rest. -->
										<form
											method="POST"
											action="?/closeService"
											use:enhance={submitHandler}
											class="mt-3 flex flex-wrap items-end gap-2"
										>
											<input type="hidden" name="recordId" value={member.recordId} />
											<div class="min-w-[12rem] flex-1">
												<label for="gclose-res-{member.recordId}" class="tron-label">
													Resolution
												</label>
												<input
													id="gclose-res-{member.recordId}"
													name="resolution"
													type="text"
													class="tron-input w-full"
													placeholder="What was done on this unit"
													style="min-height: 44px;"
												/>
											</div>
											<div>
												<label for="gclose-status-{member.recordId}" class="tron-label">
													Return to
												</label>
												<select
													id="gclose-status-{member.recordId}"
													name="returnToStatus"
													class="tron-select"
													style="min-height: 44px;"
												>
													{#each data.returnableStatuses as status (status)}
														<option value={status} selected={status === (member.previousStatus ?? 'validating')}>
															{status}
														</option>
													{/each}
												</select>
											</div>
											<TronButton type="submit" disabled={submitting} style="min-height: 44px;">
												Complete unit
											</TronButton>
										</form>
									</div>
								{/each}
							</div>

							<!-- Close everything still open under this task. -->
							<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,128,0.04)] p-4">
								<h4 class="tron-text-primary mb-3 text-sm font-bold uppercase">Close group task</h4>
								<form
									method="POST"
									action="?/closeGroupRemaining"
									use:enhance={submitHandler}
									class="grid gap-3 sm:grid-cols-3"
								>
									<input type="hidden" name="groupId" value={group.id} />
									<div class="sm:col-span-2">
										<label for="gclose-all-res-{group.id}" class="tron-label">Shared resolution</label>
										<input
											id="gclose-all-res-{group.id}"
											name="resolution"
											type="text"
											class="tron-input w-full"
											placeholder="What was done across the task"
											style="min-height: 44px;"
										/>
									</div>
									<div>
										<label for="gclose-all-status-{group.id}" class="tron-label">Return units to</label>
										<select
											id="gclose-all-status-{group.id}"
											name="returnToStatus"
											class="tron-select w-full"
											style="min-height: 44px;"
										>
											<option value="">Each unit's previous status</option>
											{#each data.returnableStatuses as status (status)}
												<option value={status}>{status}</option>
											{/each}
										</select>
									</div>
									<div class="sm:col-span-3">
										<TronButton
											type="submit"
											variant="primary"
											disabled={submitting}
											style="min-height: 44px;"
										>
											Close remaining {group.members.length + group.hiddenCount} unit(s)
										</TronButton>
									</div>
								</form>
							</div>
						</div>
					{/if}
				</TronCard>
			{/each}
		</div>
	{/if}

	<!-- Open jobs -->
	{#if data.rows.length === 0}
		<TronCard>
			<p class="tron-text-muted py-8 text-center text-sm">
				{data.totalOpen === 0
					? 'No SPUs are currently undergoing servicing. Scan a unit to start.'
					: 'No servicing SPUs match these filters.'}
			</p>
		</TronCard>
	{:else}
		<div class="space-y-3">
			{#each data.rows as row (rowKey(row))}
				{@const key = rowKey(row)}
				{@const expanded = selectedId === key}
				<TronCard class={expanded ? 'border-[var(--color-tron-cyan)]' : ''}>
					<button
						type="button"
						class="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-left"
						onclick={() => toggle(row)}
						aria-expanded={expanded}
					>
						<svg
							class="h-4 w-4 shrink-0 text-[var(--color-tron-text-secondary)] transition-transform {expanded
								? 'rotate-90'
								: ''}"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
						</svg>

						<span class="tron-text-primary min-w-[7rem] font-bold">{row.shortId}</span>
						<span class="tron-text-muted min-w-0 flex-1 truncate text-xs">{row.udi}</span>

						{#if row.needsIntake}
							<TronBadge variant="warning">Needs intake</TronBadge>
						{:else}
							<TronBadge variant="neutral">{typeLabels[row.serviceType] ?? row.serviceType}</TronBadge>
							<TronBadge variant={priorityVariant(row.priority)}>
								{priorityLabels[row.priority] ?? row.priority}
							</TronBadge>
						{/if}

						<span class="tron-text-muted text-xs">
							{row.location || 'Location not set'}
						</span>

						{#if !row.needsIntake}
							{@const changes =
								row.partsReplaced.length + row.firmwareChanges.length + row.otherChanges.length}
							{#if changes > 0}
								<TronBadge variant="info">{changes} change{changes === 1 ? '' : 's'}</TronBadge>
							{/if}
							<span class="tron-text-muted text-xs">{ageLabel(row.daysOpen)}</span>
						{/if}
					</button>

					{#if expanded}
						<div class="mt-4 space-y-4 border-t border-[var(--color-tron-border)] pt-4">
							{#if row.needsIntake}
								<!-- Legacy unit: sitting in 'servicing' with no job behind it. -->
								<div>
									<p class="tron-text-muted mb-3 text-sm">
										This unit is parked in <strong>servicing</strong> with no job behind it. Take it in
										to start tracking.
									</p>
									<form
										method="POST"
										action="?/openService"
										use:enhance={submitHandler}
										class="grid gap-3 sm:grid-cols-2"
									>
										<input type="hidden" name="spuId" value={row.spuId} />
										<div>
											<label for="intake-type-{key}" class="tron-label">Service type</label>
											<select id="intake-type-{key}" name="serviceType" class="tron-select">
												{#each data.serviceTypes as type (type)}
													<option value={type}>{typeLabels[type] ?? type}</option>
												{/each}
											</select>
										</div>
										<div>
											<label for="intake-priority-{key}" class="tron-label">Priority</label>
											<select id="intake-priority-{key}" name="priority" class="tron-select">
												{#each data.priorities as p (p)}
													<option value={p} selected={p === 'normal'}>{priorityLabels[p] ?? p}</option>
												{/each}
											</select>
										</div>
										<div>
											<label for="intake-loc-{key}" class="tron-label">Location</label>
											<input
												id="intake-loc-{key}"
												name="location"
												class="tron-input"
												list="known-locations"
												placeholder="Bench 3, Lab A"
											/>
										</div>
										<div>
											<label for="intake-reason-{key}" class="tron-label">Reason</label>
											<input
												id="intake-reason-{key}"
												name="reason"
												class="tron-input"
												placeholder="Why is it in for service?"
											/>
										</div>
										<div class="sm:col-span-2">
											<TronButton type="submit" variant="primary" disabled={submitting}>
												Take unit in
											</TronButton>
										</div>
									</form>
								</div>
							{:else}
								<!-- Triage: one click each, no save button. -->
								<div class="grid gap-4 lg:grid-cols-2">
									<div>
										<h4 class="tron-text-primary mb-2 text-sm font-bold uppercase">Service type</h4>
										<div class="flex flex-wrap gap-2">
											{#each data.serviceTypes as type (type)}
												<form
													method="POST"
													action="?/updateService"
													use:enhance={submitHandler}
													class="contents"
												>
													<input type="hidden" name="recordId" value={row.recordId} />
													<input type="hidden" name="serviceType" value={type} />
													<button
														type="submit"
														disabled={submitting}
														class="rounded-full border px-3 py-1 text-xs transition-colors {row.serviceType ===
														type
															? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
															: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]'}"
													>
														{typeLabels[type] ?? type}
													</button>
												</form>
											{/each}
										</div>
									</div>

									<div>
										<h4 class="tron-text-primary mb-2 text-sm font-bold uppercase">Priority</h4>
										<div class="flex flex-wrap gap-2">
											{#each data.priorities as p (p)}
												<form
													method="POST"
													action="?/updateService"
													use:enhance={submitHandler}
													class="contents"
												>
													<input type="hidden" name="recordId" value={row.recordId} />
													<input type="hidden" name="priority" value={p} />
													<button
														type="submit"
														disabled={submitting}
														class="rounded-full border px-3 py-1 text-xs transition-colors {row.priority ===
														p
															? 'border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)]'
															: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]'}"
													>
														{priorityLabels[p] ?? p}
													</button>
												</form>
											{/each}
										</div>
									</div>
								</div>

								<!-- Unit detail -->
								<div
									class="grid gap-x-6 gap-y-2 rounded border border-[var(--color-tron-border)] p-3 text-xs sm:grid-cols-3"
								>
									<div>
										<span class="tron-text-muted">SPU status</span>
										<div class="mt-1"><SpuStatusBadge status={row.spuStatus} /></div>
									</div>
									<div>
										<span class="tron-text-muted">Customer</span>
										<p class="tron-text-primary">{row.customer ?? '—'}</p>
									</div>
									<div>
										<span class="tron-text-muted">Owner</span>
										<p class="tron-text-primary">{row.owner ?? '—'}</p>
									</div>
									<div>
										<span class="tron-text-muted">Barcode</span>
										<p class="tron-text-primary font-mono">{row.barcode ?? '—'}</p>
									</div>
									<div>
										<span class="tron-text-muted">Opened</span>
										<p class="tron-text-primary">
											{formatDate(row.openedAt)}{#if row.openedBy}&nbsp;by {row.openedBy}{/if}
										</p>
									</div>
									<div>
										<span class="tron-text-muted">Returns to</span>
										<p class="tron-text-primary">{row.previousStatus ?? 'not recorded'}</p>
									</div>
									{#if row.reason}
										<div class="sm:col-span-3">
											<span class="tron-text-muted">Reason</span>
											<p class="tron-text-primary">{row.reason}</p>
										</div>
									{/if}
									<div class="sm:col-span-3">
										<a
											href="/spu/{row.spuId}"
											class="text-[var(--color-tron-cyan)] hover:underline"
										>
											Open full SPU record →
										</a>
									</div>
								</div>

								<!-- Move: one click per known bench -->
								<div>
									<h4 class="tron-text-primary mb-2 text-sm font-bold uppercase">
										Location
										<span class="tron-text-muted font-normal normal-case">
											— currently {row.location || 'not set'}
										</span>
									</h4>
									<div class="mb-2 flex flex-wrap gap-2">
										{#each data.knownLocations as loc (loc)}
											{#if loc !== row.location}
												<form
													method="POST"
													action="?/moveLocation"
													use:enhance={submitHandler}
													class="contents"
												>
													<input type="hidden" name="recordId" value={row.recordId} />
													<input type="hidden" name="location" value={loc} />
													<button
														type="submit"
														disabled={submitting}
														class="rounded-full border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
													>
														→ {loc}
													</button>
												</form>
											{/if}
										{/each}
									</div>
									<form
										method="POST"
										action="?/moveLocation"
										use:enhance={submitHandler}
										class="flex flex-wrap gap-2"
									>
										<input type="hidden" name="recordId" value={row.recordId} />
										<input
											name="location"
											class="tron-input flex-1"
											list="known-locations"
											placeholder="Move somewhere else..."
											required
										/>
										<input name="note" class="tron-input flex-1" placeholder="Note (optional)" />
										<TronButton type="submit" size="sm" disabled={submitting}>Move</TronButton>
									</form>

									{#if row.locationHistory.length > 0}
										<ul class="mt-3 space-y-1 text-xs">
											{#each row.locationHistory.slice().reverse() as move (move.id)}
												<li class="tron-text-muted">
													{formatDateTime(move.movedAt)} —
													<span class="tron-text-primary">
														{move.from || 'intake'} → {move.to}
													</span>
													{#if move.movedBy}&nbsp;({move.movedBy}){/if}
													{#if move.note}&nbsp;· {move.note}{/if}
												</li>
											{/each}
										</ul>
									{/if}
								</div>

								<!-- What changed on the unit -->
								<div class="grid gap-4 lg:grid-cols-2">
									<div>
										<h4 class="tron-text-primary mb-2 text-sm font-bold uppercase">
											Parts replaced
										</h4>
										{#if row.partsReplaced.length > 0}
											<ul class="mb-3 space-y-1 text-xs">
												{#each row.partsReplaced as pr (pr.id)}
													<li class="tron-text-muted">
														<span class="tron-text-primary font-mono">{pr.partNumber}</span>
														{pr.partName}
														— lot {pr.oldLotNumber || '—'} → <span class="tron-text-primary"
															>{pr.newLotNumber}</span
														>
														{#if pr.newSerialNumber}&nbsp;(SN {pr.newSerialNumber}){/if}
														<br />
														{formatDateTime(pr.replacedAt)}
														{#if pr.replacedBy}&nbsp;by {pr.replacedBy}{/if} · {pr.reason}
													</li>
												{/each}
											</ul>
										{/if}

										{#if row.parts.some((p: any) => !p.isReplaced)}
											{@const swappable = row.parts.filter((p: any) => !p.isReplaced)}
											<form
												method="POST"
												action="?/replacePart"
												use:enhance={submitHandler}
												class="space-y-2"
											>
												<input type="hidden" name="recordId" value={row.recordId} />
												<select name="spuPartId" class="tron-select" required>
													<option value="">Which part came out?</option>
													{#each swappable as part (part.id)}
														<option value={part.id}>
															{part.partNumber} — {part.partName} (lot {part.lotNumber || '—'})
														</option>
													{/each}
												</select>
												<div class="flex gap-2">
													<input
														name="newLotNumber"
														class="tron-input flex-1"
														placeholder="New lot #"
														required
													/>
													<input
														name="newSerialNumber"
														class="tron-input flex-1"
														placeholder="New serial (optional)"
													/>
												</div>
												<input
													name="reason"
													class="tron-input"
													placeholder="Reason (required for traceability)"
													required
												/>
												<TronButton type="submit" size="sm" disabled={submitting}>
													Record part swap
												</TronButton>
											</form>
										{:else}
											<p class="tron-text-muted text-xs">No as-built parts recorded on this unit.</p>
										{/if}
									</div>

									<div class="space-y-4">
										<div>
											<h4 class="tron-text-primary mb-2 text-sm font-bold uppercase">Firmware</h4>
											{#if row.firmwareChanges.length > 0}
												<ul class="mb-3 space-y-1 text-xs">
													{#each row.firmwareChanges as fw (fw.id)}
														<li class="tron-text-muted">
															<span class="tron-text-primary">{fw.deviceType}</span>
															{fw.previousVersion || '—'} → <span class="tron-text-primary"
																>{fw.newVersion}</span
															>
															<br />
															{formatDateTime(fw.performedAt)}
															{#if fw.performedBy}&nbsp;by {fw.performedBy}{/if}
														</li>
													{/each}
												</ul>
											{/if}
											<form
												method="POST"
												action="?/recordFirmwareChange"
												use:enhance={submitHandler}
												class="space-y-2"
											>
												<input type="hidden" name="recordId" value={row.recordId} />
												<div class="flex gap-2">
													<input
														name="deviceType"
														class="tron-input flex-1"
														placeholder="Device (e.g. SPU board)"
														required
													/>
													<input
														name="previousVersion"
														class="tron-input w-24"
														placeholder="from"
													/>
													<input name="newVersion" class="tron-input w-24" placeholder="to" required />
												</div>
												<TronButton type="submit" size="sm" disabled={submitting}>
													Record flash
												</TronButton>
											</form>
										</div>

										<div>
											<h4 class="tron-text-primary mb-2 text-sm font-bold uppercase">
												Other changes
											</h4>
											{#if row.otherChanges.length > 0}
												<ul class="mb-3 space-y-1 text-xs">
													{#each row.otherChanges as oc (oc.id)}
														<li class="tron-text-muted">
															<span class="tron-text-primary">{oc.category}</span> — {oc.description}
															<br />
															{formatDateTime(oc.performedAt)}
															{#if oc.performedBy}&nbsp;by {oc.performedBy}{/if}
														</li>
													{/each}
												</ul>
											{/if}
											<form
												method="POST"
												action="?/recordOtherChange"
												use:enhance={submitHandler}
												class="space-y-2"
											>
												<input type="hidden" name="recordId" value={row.recordId} />
												<div class="flex gap-2">
													<select name="category" class="tron-select w-40">
														{#each changeCategories as cat (cat)}
															<option value={cat}>{cat}</option>
														{/each}
													</select>
													<input
														name="description"
														class="tron-input flex-1"
														placeholder="What changed?"
														required
													/>
												</div>
												<TronButton type="submit" size="sm" disabled={submitting}>
													Record change
												</TronButton>
											</form>
										</div>
									</div>
								</div>

								<!-- Notes -->
								<div>
									<h4 class="tron-text-primary mb-2 text-sm font-bold uppercase">Notes</h4>
									{#if row.notes.length > 0}
										<ul class="mb-2 space-y-1 text-xs">
											{#each row.notes.slice().reverse() as note (note.id)}
												<li class="tron-text-muted">
													{formatDateTime(note.addedAt)}
													{#if note.addedBy}&nbsp;· {note.addedBy}{/if}
													<br />
													<span class="tron-text-primary">{note.text}</span>
												</li>
											{/each}
										</ul>
									{/if}
									<form
										method="POST"
										action="?/addNote"
										use:enhance={submitHandler}
										class="flex gap-2"
									>
										<input type="hidden" name="recordId" value={row.recordId} />
										<input name="text" class="tron-input flex-1" placeholder="Add a note..." required />
										<TronButton type="submit" size="sm" disabled={submitting}>Add</TronButton>
									</form>
								</div>

								<!-- Close -->
								<div class="border-t border-[var(--color-tron-border)] pt-4">
									<h4 class="tron-text-primary mb-2 text-sm font-bold uppercase">Close job</h4>
									<form
										method="POST"
										action="?/closeService"
										use:enhance={submitHandler}
										class="grid gap-3 sm:grid-cols-3"
									>
										<input type="hidden" name="recordId" value={row.recordId} />
										<div class="sm:col-span-2">
											<label for="close-res-{key}" class="tron-label">Resolution</label>
											<input
												id="close-res-{key}"
												name="resolution"
												class="tron-input"
												placeholder="What was done?"
											/>
										</div>
										<div>
											<label for="close-status-{key}" class="tron-label">Return unit to</label>
											<select id="close-status-{key}" name="returnToStatus" class="tron-select">
												{#each data.returnableStatuses as status (status)}
													<option value={status} selected={status === row.previousStatus}>
														{status}
													</option>
												{/each}
											</select>
										</div>
										<div class="sm:col-span-3">
											<TronButton type="submit" variant="primary" disabled={submitting}>
												Close job
											</TronButton>
										</div>
									</form>
								</div>
							{/if}
						</div>
					{/if}
				</TronCard>
			{/each}
		</div>
	{/if}

	<!-- Recently closed -->
	{#if data.recentlyClosed.length > 0}
		<TronCard>
			<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase">Recently closed</h3>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left">
							<th class="tron-text-muted py-2 pr-4 font-medium">SPU</th>
							<th class="tron-text-muted py-2 pr-4 font-medium">Type</th>
							<th class="tron-text-muted py-2 pr-4 font-medium">Resolution</th>
							<th class="tron-text-muted py-2 pr-4 font-medium">Returned to</th>
							<th class="tron-text-muted py-2 font-medium">Closed</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recentlyClosed as rec (rec.id)}
							<tr class="border-b border-[var(--color-tron-border)]/40">
								<td class="py-2 pr-4">
									<a href="/spu/{rec.spuId}" class="text-[var(--color-tron-cyan)] hover:underline">
										{rec.shortId || rec.udi}
									</a>
								</td>
								<td class="tron-text-secondary py-2 pr-4">{typeLabels[rec.serviceType] ?? rec.serviceType}</td>
								<td class="tron-text-secondary py-2 pr-4">{rec.resolution ?? '—'}</td>
								<td class="tron-text-secondary py-2 pr-4">{rec.returnedToStatus ?? '—'}</td>
								<td class="tron-text-muted py-2">
									{formatDate(rec.closedAt)}
									{#if rec.closedBy}· {rec.closedBy}{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</TronCard>
	{/if}

	<h3 class="tron-text-muted border-t border-[var(--color-tron-border)] pt-6 text-sm font-bold uppercase">
		Statistics
	</h3>

	<!-- Summary -->
	<div class="grid gap-4 sm:grid-cols-3">
		<TronCard>
			<p class="tron-text-muted text-xs font-bold uppercase">Open jobs</p>
			<p class="tron-text-primary text-3xl font-bold">{data.totalOpen}</p>
		</TronCard>
		<TronCard>
			<p class="tron-text-muted text-xs font-bold uppercase">Needs intake</p>
			<p
				class="text-3xl font-bold {data.needsIntakeCount > 0
					? 'text-[var(--color-tron-orange)]'
					: 'tron-text-primary'}"
			>
				{data.needsIntakeCount}
			</p>
		</TronCard>
		<TronCard>
			<p class="tron-text-muted text-xs font-bold uppercase">Oldest job</p>
			<p class="tron-text-primary text-3xl font-bold">{ageLabel(data.oldestDays)}</p>
		</TronCard>
	</div>

	<!-- Where they are -->
	{#if data.byLocation.length > 0}
		<TronCard>
			<h3 class="tron-text-primary mb-3 text-sm font-bold uppercase">Where they are</h3>
			<div class="flex flex-wrap gap-2">
				{#each data.byLocation as bucket (bucket.location)}
					<a
						href="/spu/mfg/servicing?location={encodeURIComponent(
							bucket.location === 'Unassigned' ? '__unassigned__' : bucket.location
						)}"
						class="rounded-full border border-[var(--color-tron-border)] px-3 py-1 text-xs transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
					>
						{bucket.location}
						<span class="tron-text-muted">· {bucket.count}</span>
					</a>
				{/each}
			</div>
		</TronCard>
	{/if}
</div>

<!-- Shared location suggestions for every location input on the page. -->
<datalist id="known-locations">
	{#each data.knownLocations as loc (loc)}
		<option value={loc}></option>
	{/each}
</datalist>

<!-- Manual open, for a unit whose label will not scan. -->
{#if showOpenModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<TronCard class="w-full max-w-lg">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="tron-text-primary text-lg font-bold">Start Service Job</h3>
				<button
					type="button"
					class="tron-text-muted hover:text-[var(--color-tron-cyan)]"
					onclick={() => (showOpenModal = false)}
					aria-label="Close"
				>
					✕
				</button>
			</div>

			<form
				method="POST"
				action="?/openService"
				use:enhance={submitHandler}
				class="space-y-4"
			>
				<div>
					<label for="open-spu" class="tron-label">SPU</label>
					<select id="open-spu" name="spuId" class="tron-select" required>
						<option value="">Select a unit...</option>
						{#each data.eligibleSpus as spu (spu.id)}
							<option value={spu.id}>
								{spu.shortId} — {spu.status}{spu.customer ? ` — ${spu.customer}` : ''}
							</option>
						{/each}
					</select>
				</div>

				<div class="grid gap-3 sm:grid-cols-2">
					<div>
						<label for="open-type" class="tron-label">Service type</label>
						<select id="open-type" name="serviceType" class="tron-select">
							{#each data.serviceTypes as type (type)}
								<option value={type}>{typeLabels[type] ?? type}</option>
							{/each}
						</select>
					</div>
					<div>
						<label for="open-priority" class="tron-label">Priority</label>
						<select id="open-priority" name="priority" class="tron-select">
							{#each data.priorities as p (p)}
								<option value={p} selected={p === 'normal'}>{priorityLabels[p] ?? p}</option>
							{/each}
						</select>
					</div>
				</div>

				<div>
					<label for="open-location" class="tron-label">Location</label>
					<input
						id="open-location"
						name="location"
						class="tron-input"
						list="known-locations"
						placeholder="Bench 3, Lab A"
					/>
				</div>

				<div>
					<label for="open-reason" class="tron-label">Reason</label>
					<input
						id="open-reason"
						name="reason"
						class="tron-input"
						placeholder="Why is it in for service?"
					/>
				</div>

				<div class="flex justify-end gap-2">
					<TronButton variant="ghost" onclick={() => (showOpenModal = false)}>Cancel</TronButton>
					<TronButton type="submit" variant="primary" disabled={submitting}>Open job</TronButton>
				</div>
			</form>
		</TronCard>
	</div>
{/if}

{#if showGroupModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto">
			<TronCard>
				<div class="mb-4 flex items-center justify-between">
					<h3 class="tron-text-primary text-lg font-bold">New Group Task</h3>
					<button
						type="button"
						class="tron-text-muted hover:text-[var(--color-tron-cyan)]"
						onclick={() => (showGroupModal = false)}
						aria-label="Close"
					>
						&#10005;
					</button>
				</div>

				<form method="POST" action="?/createGroup" use:enhance={submitHandler} class="space-y-4">
					<div>
						<label for="group-name" class="tron-label">Task</label>
						<input
							id="group-name"
							name="name"
							type="text"
							class="tron-input w-full"
							placeholder="e.g. Recalibrate magnetometer after thermistor fix"
							required
							style="min-height: 44px;"
						/>
					</div>

					<div class="grid gap-4 sm:grid-cols-2">
						<div>
							<label for="group-type" class="tron-label">Service type</label>
							<select id="group-type" name="serviceType" class="tron-select w-full" style="min-height: 44px;">
								{#each data.serviceTypes as type (type)}
									<option value={type}>{typeLabels[type] ?? type}</option>
								{/each}
							</select>
						</div>
						<div>
							<label for="group-priority" class="tron-label">Priority</label>
							<select id="group-priority" name="priority" class="tron-select w-full" style="min-height: 44px;">
								{#each data.priorities as p (p)}
									<option value={p} selected={p === 'normal'}>{priorityLabels[p] ?? p}</option>
								{/each}
							</select>
						</div>
					</div>

					<div>
						<label for="group-location" class="tron-label">Where are the units? (optional)</label>
						<input
							id="group-location"
							name="location"
							type="text"
							list="known-locations"
							class="tron-input w-full"
							placeholder="e.g. Bench 3, Lab A"
							style="min-height: 44px;"
						/>
					</div>

					<div>
						<label for="group-desc" class="tron-label">Description</label>
						<textarea
							id="group-desc"
							name="description"
							rows="2"
							class="tron-input w-full"
							placeholder="What the task involves..."
						></textarea>
					</div>

					<div>
						<label for="group-pick-q" class="tron-label">
							SPUs ({groupPicks.length} selected)
						</label>
						<input
							id="group-pick-q"
							type="text"
							class="tron-input mb-2 w-full"
							placeholder="Filter by SPU, UDI, barcode, customer..."
							bind:value={groupPickQuery}
							style="min-height: 44px;"
						/>
						<div
							class="max-h-56 overflow-y-auto rounded border border-[var(--color-tron-border)] p-2"
						>
							{#each groupPickOptions as spu (spu.id)}
								<label
									class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[rgba(0,229,255,0.06)]"
								>
									<input
										type="checkbox"
										checked={groupPicks.includes(spu.id)}
										onchange={() => togglePick(spu.id)}
									/>
									<span class="tron-text-primary font-medium">{spu.shortId}</span>
									<span class="tron-text-muted text-xs">{spu.status}</span>
									{#if spu.inServicing}
										<span class="text-xs text-[var(--color-tron-orange)]">· already in servicing</span>
									{/if}
									{#if spu.customer}
										<span class="tron-text-muted text-xs">· {spu.customer}</span>
									{/if}
								</label>
							{:else}
								<p class="tron-text-muted p-2 text-sm">No SPUs match that filter.</p>
							{/each}
						</div>
						<p class="tron-text-muted mt-1 text-xs">
							Pick at least two. Units not already in servicing get pulled in with their own
							service job.
						</p>
					</div>

					{#each groupPicks as id (id)}
						<input type="hidden" name="spuIds" value={id} />
					{/each}

					{#if form?.error}
						<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
							<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
						</div>
					{/if}

					<div class="flex gap-3 pt-2">
						<TronButton
							type="button"
							class="flex-1"
							onclick={() => (showGroupModal = false)}
							disabled={submitting}
						>
							Cancel
						</TronButton>
						<TronButton
							type="submit"
							variant="primary"
							class="flex-1"
							disabled={submitting || groupPicks.length < 2}
						>
							{submitting ? 'Creating...' : `Create task for ${groupPicks.length} units`}
						</TronButton>
					</div>
				</form>
			</TronCard>
		</div>
	</div>
{/if}
