<script lang="ts">
	import { enhance } from '$app/forms';

	interface DeckRun {
		runId: string;
		robotId: string;
		status: string;
		operatorName: string;
		waxSourceLot: string | null;
		cartridgeCount: number;
		coolingTrayId: string | null;
		durationMinutes: number | null;
		date: string;
	}

	interface TrayRun {
		runId: string;
		robotId: string;
		deckId: string | null;
		status: string;
		operatorName: string;
		cartridgeCount: number;
		durationMinutes: number | null;
		date: string;
	}

	interface Deck {
		deckId: string;
		status: string;
		currentRobotId: string | null;
		lastUsed: string | null;
		lockoutUntil: string | null;
		totalRuns: number;
		createdAt: string;
		recentRuns: DeckRun[];
	}

	interface Tray {
		trayId: string;
		status: string;
		assignedRunId: string | null;
		totalRuns: number;
		createdAt: string;
		recentRuns: TrayRun[];
	}

	interface Props {
		data: { decks: Deck[]; trays: Tray[]; isAdmin: boolean };
		form: { success?: boolean; error?: string; message?: string } | null;
	}

	let { data, form }: Props = $props();

	let showAddDeck = $state(false);
	let showAddTray = $state(false);
	let newDeckId = $state('');
	let newTrayId = $state('');
	let expandedDeck = $state<string | null>(null);
	let expandedTray = $state<string | null>(null);

	// Admin override state
	let overrideDeckId = $state<string | null>(null);
	let overrideTrayId = $state<string | null>(null);
	let overridePassword = $state('');
	let overrideReason = $state('');
	let overrideNewStatus = $state('Available');

	const deckStatuses = ['Available', 'In Use', 'Cooldown Lockout', 'Needs Cleaning', 'Out of Service'];
	const trayStatuses = ['Available', 'In Use', 'In QC', 'Needs Cleaning'];

	function openDeckOverride(deckId: string) {
		overrideDeckId = deckId;
		overrideTrayId = null;
		overridePassword = '';
		overrideReason = '';
		overrideNewStatus = 'Available';
	}

	function openTrayOverride(trayId: string) {
		overrideTrayId = trayId;
		overrideDeckId = null;
		overridePassword = '';
		overrideReason = '';
		overrideNewStatus = 'Available';
	}

	function closeOverride() {
		overrideDeckId = null;
		overrideTrayId = null;
		overridePassword = '';
		overrideReason = '';
	}

	function statusBadgeClass(status: string): string {
		switch (status) {
			case 'Available':
				return 'border-green-500/60 bg-green-900/30 text-green-400';
			case 'In Use':
				return 'border-amber-500/60 bg-amber-900/30 text-amber-400';
			case 'Locked Out':
			case 'Cooldown Lockout':
				return 'border-red-500/60 bg-red-900/30 text-red-400';
			case 'In QC':
				return 'border-blue-500/60 bg-blue-900/30 text-blue-400';
			case 'Needs Cleaning':
				return 'border-orange-500/60 bg-orange-900/30 text-orange-400';
			case 'Out of Service':
				return 'border-gray-500/60 bg-gray-900/30 text-gray-400';
			default:
				return 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] text-[var(--color-tron-text-secondary)]';
		}
	}

	function statusDot(status: string): string {
		switch (status) {
			case 'Available': return 'bg-green-400';
			case 'In Use': return 'bg-amber-400';
			case 'Locked Out':
			case 'Cooldown Lockout': return 'bg-red-400';
			case 'In QC': return 'bg-blue-400';
			case 'Needs Cleaning': return 'bg-orange-400';
			case 'Out of Service': return 'bg-gray-400';
			default: return 'bg-[var(--color-tron-text-secondary)]';
		}
	}

	function cardBorderClass(status: string): string {
		switch (status) {
			case 'Available': return 'border-l-green-500';
			case 'In Use': return 'border-l-amber-500';
			case 'Locked Out':
			case 'Cooldown Lockout': return 'border-l-red-500';
			case 'In QC': return 'border-l-blue-500';
			case 'Needs Cleaning': return 'border-l-orange-500';
			case 'Out of Service': return 'border-l-gray-500';
			default: return 'border-l-[var(--color-tron-border)]';
		}
	}

	function isLockedOut(deck: Deck): boolean {
		if (!deck.lockoutUntil) return false;
		return new Date(deck.lockoutUntil) > new Date();
	}

	function effectiveStatus(deck: Deck): string {
		if (isLockedOut(deck)) return 'Locked Out';
		return deck.status;
	}

	function runStatusDot(status: string): string {
		switch (status) {
			case 'Completed': return 'bg-green-400';
			case 'Aborted': return 'bg-red-400';
			default: return 'bg-amber-400';
		}
	}

	function toggleDeck(deckId: string) {
		expandedDeck = expandedDeck === deckId ? null : deckId;
	}

	function toggleTray(trayId: string) {
		expandedTray = expandedTray === trayId ? null : trayId;
	}
</script>

<div class="space-y-8">
	<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Decks & Trays</h1>

	{#if form?.success}
		<div class="rounded border border-green-500/30 bg-green-900/20 px-4 py-3 text-sm text-green-300">
			{form.message ?? 'Action completed.'}
		</div>
	{/if}
	{#if form?.error}
		<div class="rounded border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- ====== ADMIN OVERRIDE MODAL (Deck) ====== -->
	{#if overrideDeckId}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onclick={(e) => { if (e.target === e.currentTarget) closeOverride(); }}>
			<div class="mx-4 w-full max-w-md rounded-lg border border-red-500/40 bg-[var(--color-tron-bg)] shadow-2xl">
				<div class="border-b border-red-500/30 px-5 py-4">
					<h3 class="text-base font-bold text-red-400">Admin Override - Deck</h3>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Force-release <span class="font-mono font-bold text-[var(--color-tron-cyan)]">{overrideDeckId}</span> from its current step.
						Any active runs using this deck will be aborted.
					</p>
				</div>
				<form
					method="POST"
					action="?/forceReleaseDeck"
					use:enhance={() => {
						return async ({ update }) => {
							closeOverride();
							await update();
						};
					}}
					class="space-y-4 px-5 py-4"
				>
					<input type="hidden" name="deckId" value={overrideDeckId} />
					<div>
						<label for="override-deck-status" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">New Status</label>
						<select id="override-deck-status" name="newStatus" bind:value={overrideNewStatus} class="tron-input w-full">
							{#each deckStatuses as s (s)}
								<option value={s}>{s}</option>
							{/each}
						</select>
					</div>
					<div>
						<label for="override-deck-reason" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Reason</label>
						<input id="override-deck-reason" type="text" name="reason" bind:value={overrideReason} required placeholder="Why is this override needed?" class="tron-input w-full" />
					</div>
					<div>
						<label for="override-deck-pw" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Your Password (to confirm)</label>
						<input id="override-deck-pw" type="password" name="password" bind:value={overridePassword} required placeholder="Enter your password" class="tron-input w-full" autocomplete="current-password" />
					</div>
					<div class="rounded border border-amber-500/30 bg-amber-900/15 px-3 py-2">
						<p class="text-xs text-amber-300">
							<strong>Warning:</strong> This will abort any active wax or reagent filling runs using this deck
							and force its status to "{overrideNewStatus}". This action is logged.
						</p>
					</div>
					<div class="flex justify-end gap-2 pt-1">
						<button type="button" onclick={() => closeOverride()} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface-hover)]">
							Cancel
						</button>
						<button type="submit" class="rounded border border-red-500 bg-red-900/40 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-900/60">
							Force Release
						</button>
					</div>
				</form>
			</div>
		</div>
	{/if}

	<!-- ====== ADMIN OVERRIDE MODAL (Tray) ====== -->
	{#if overrideTrayId}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onclick={(e) => { if (e.target === e.currentTarget) closeOverride(); }}>
			<div class="mx-4 w-full max-w-md rounded-lg border border-red-500/40 bg-[var(--color-tron-bg)] shadow-2xl">
				<div class="border-b border-red-500/30 px-5 py-4">
					<h3 class="text-base font-bold text-red-400">Admin Override - Tray</h3>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Force-release <span class="font-mono font-bold text-[var(--color-tron-cyan)]">{overrideTrayId}</span> from its current step.
					</p>
				</div>
				<form
					method="POST"
					action="?/forceReleaseTray"
					use:enhance={() => {
						return async ({ update }) => {
							closeOverride();
							await update();
						};
					}}
					class="space-y-4 px-5 py-4"
				>
					<input type="hidden" name="trayId" value={overrideTrayId} />
					<div>
						<label for="override-tray-status" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">New Status</label>
						<select id="override-tray-status" name="newStatus" bind:value={overrideNewStatus} class="tron-input w-full">
							{#each trayStatuses as s (s)}
								<option value={s}>{s}</option>
							{/each}
						</select>
					</div>
					<div>
						<label for="override-tray-reason" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Reason</label>
						<input id="override-tray-reason" type="text" name="reason" bind:value={overrideReason} required placeholder="Why is this override needed?" class="tron-input w-full" />
					</div>
					<div>
						<label for="override-tray-pw" class="mb-1 block text-xs font-medium text-[var(--color-tron-text-secondary)]">Your Password (to confirm)</label>
						<input id="override-tray-pw" type="password" name="password" bind:value={overridePassword} required placeholder="Enter your password" class="tron-input w-full" autocomplete="current-password" />
					</div>
					<div class="rounded border border-amber-500/30 bg-amber-900/15 px-3 py-2">
						<p class="text-xs text-amber-300">
							<strong>Warning:</strong> This will force the tray status to "{overrideNewStatus}" and clear its run assignment. This action is logged.
						</p>
					</div>
					<div class="flex justify-end gap-2 pt-1">
						<button type="button" onclick={() => closeOverride()} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface-hover)]">
							Cancel
						</button>
						<button type="submit" class="rounded border border-red-500 bg-red-900/40 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-900/60">
							Force Release
						</button>
					</div>
				</form>
			</div>
		</div>
	{/if}

	<!-- ====== DECKS SECTION ====== -->
	<section>
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-lg font-medium text-[var(--color-tron-cyan)]">Decks <span class="ml-1 text-sm font-normal text-[var(--color-tron-text-secondary)]">({data.decks.length})</span></h2>
			<button
				type="button"
				onclick={() => { showAddDeck = !showAddDeck; }}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
			>
				{showAddDeck ? 'Cancel' : '+ Register Deck'}
			</button>
		</div>

		{#if showAddDeck}
			<form method="POST" action="?/createDeck" use:enhance={() => { return async ({ update }) => { showAddDeck = false; newDeckId = ''; await update(); }; }} class="mb-4 flex gap-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<input type="text" name="deckId" bind:value={newDeckId} required class="tron-input flex-1" placeholder="Deck barcode / ID..." />
				<button type="submit" class="tron-btn-primary">Register</button>
			</form>
		{/if}

		<div class="space-y-3">
			{#each data.decks as deck (deck.deckId)}
				{@const deckStatus = effectiveStatus(deck)}
				<div class="rounded-lg border border-l-4 border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] {cardBorderClass(deckStatus)}">
					<!-- Card header — clickable to expand history -->
					<div class="flex items-center justify-between p-4">
						<div class="flex-1">
							<div class="flex items-center gap-3">
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a href="/spu/equipment/decks-trays/deck?id={deck.deckId}" class="font-mono text-sm font-semibold text-[var(--color-tron-cyan)] hover:underline">{deck.deckId}</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium {statusBadgeClass(deckStatus)}">
									<span class="h-1.5 w-1.5 rounded-full {statusDot(deckStatus)}"></span>
									{deckStatus}
								</span>
								{#if deck.currentRobotId}
									<span class="font-mono text-xs text-[var(--color-tron-text-secondary)]">Robot: {deck.currentRobotId}</span>
								{/if}
							</div>
							<div class="mt-1 flex items-center gap-4 text-xs text-[var(--color-tron-text-secondary)]">
								<span>{deck.totalRuns} runs</span>
								{#if deck.lastUsed}
									<span>Last used: {new Date(deck.lastUsed).toLocaleString()}</span>
								{/if}
								<span>Registered: {new Date(deck.createdAt).toLocaleDateString()}</span>
							</div>
							{#if deckStatus === 'Locked Out' && deck.lockoutUntil}
								<p class="mt-1 text-xs text-red-400">
									Lockout expires: {new Date(deck.lockoutUntil).toLocaleString()}
								</p>
							{/if}
						</div>
						<div class="flex items-center gap-2">
							{#if data.isAdmin && deckStatus !== 'Available'}
								<button
									type="button"
									onclick={() => openDeckOverride(deck.deckId)}
									class="rounded border border-red-500/30 px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/20"
								>
									Override
								</button>
							{/if}
							{#if deck.recentRuns.length > 0}
								<button
									type="button"
									onclick={() => toggleDeck(deck.deckId)}
									class="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface-hover)] hover:text-[var(--color-tron-cyan)]"
								>
									<svg class="h-4 w-4 transition-transform {expandedDeck === deck.deckId ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
									History
								</button>
							{/if}
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a href="/spu/equipment/decks-trays/deck?id={deck.deckId}" class="rounded p-1 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
							</a>
						</div>
					</div>

					<!-- Expandable recent run history -->
					{#if expandedDeck === deck.deckId && deck.recentRuns.length > 0}
						<div class="border-t border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg-tertiary)] px-4 py-3">
							<p class="mb-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Recent Runs (last {deck.recentRuns.length})</p>
							<div class="overflow-x-auto">
								<table class="w-full text-xs">
									<thead>
										<tr class="text-left text-[var(--color-tron-text-secondary)]">
											<th class="pb-1.5 pr-3 font-medium">Run ID</th>
											<th class="pb-1.5 pr-3 font-medium">Status</th>
											<th class="pb-1.5 pr-3 font-medium">Operator</th>
											<th class="pb-1.5 pr-3 font-medium">Robot</th>
											<th class="pb-1.5 pr-3 font-medium">Wax Source</th>
											<th class="pb-1.5 pr-3 font-medium">Cartridges</th>
											<th class="pb-1.5 pr-3 font-medium">Duration</th>
											<th class="pb-1.5 pr-3 font-medium">Cooling Tray</th>
											<th class="pb-1.5 font-medium">Date</th>
										</tr>
									</thead>
									<tbody>
										{#each deck.recentRuns as run (run.runId)}
											<tr class="border-t border-[var(--color-tron-border)]/30">
												<td class="py-1.5 pr-3 font-mono text-[var(--color-tron-cyan)]">{run.runId}</td>
												<td class="py-1.5 pr-3">
													<span class="inline-flex items-center gap-1">
														<span class="h-1.5 w-1.5 rounded-full {runStatusDot(run.status)}"></span>
														{run.status}
													</span>
												</td>
												<td class="py-1.5 pr-3">{run.operatorName}</td>
												<td class="py-1.5 pr-3 font-mono">{run.robotId}</td>
												<td class="py-1.5 pr-3 text-[var(--color-tron-text-secondary)]">{run.waxSourceLot ?? '-'}</td>
												<td class="py-1.5 pr-3">{run.cartridgeCount}</td>
												<td class="py-1.5 pr-3">{run.durationMinutes != null ? `${run.durationMinutes}m` : '-'}</td>
												<td class="py-1.5 pr-3 font-mono text-[var(--color-tron-text-secondary)]">{run.coolingTrayId ?? '-'}</td>
												<td class="py-1.5 text-[var(--color-tron-text-secondary)]">{new Date(run.date).toLocaleDateString()}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}
				</div>
			{/each}
			{#if data.decks.length === 0}
				<p class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center text-sm text-[var(--color-tron-text-secondary)]">No decks registered.</p>
			{/if}
		</div>
	</section>

	<!-- Divider -->
	<hr class="border-[var(--color-tron-border)]/50" />

	<!-- ====== TRAYS SECTION ====== -->
	<section>
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-lg font-medium text-[var(--color-tron-cyan)]">Cooling Trays <span class="ml-1 text-sm font-normal text-[var(--color-tron-text-secondary)]">({data.trays.length})</span></h2>
			<button
				type="button"
				onclick={() => { showAddTray = !showAddTray; }}
				class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
			>
				{showAddTray ? 'Cancel' : '+ Register Tray'}
			</button>
		</div>

		{#if showAddTray}
			<form method="POST" action="?/createTray" use:enhance={() => { return async ({ update }) => { showAddTray = false; newTrayId = ''; await update(); }; }} class="mb-4 flex gap-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<input type="text" name="trayId" bind:value={newTrayId} required class="tron-input flex-1" placeholder="Tray barcode / ID..." />
				<button type="submit" class="tron-btn-primary">Register</button>
			</form>
		{/if}

		<div class="space-y-3">
			{#each data.trays as tray (tray.trayId)}
				<div class="rounded-lg border border-l-4 border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] {cardBorderClass(tray.status)}">
					<!-- Card header -->
					<div class="flex items-center justify-between p-4">
						<div class="flex-1">
							<div class="flex items-center gap-3">
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a href="/spu/equipment/decks-trays/tray?id={tray.trayId}" class="font-mono text-sm font-semibold text-[var(--color-tron-cyan)] hover:underline">{tray.trayId}</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium {statusBadgeClass(tray.status)}">
									<span class="h-1.5 w-1.5 rounded-full {statusDot(tray.status)}"></span>
									{tray.status}
								</span>
								{#if tray.assignedRunId}
									<span class="font-mono text-xs text-[var(--color-tron-text-secondary)]">Run: {tray.assignedRunId}</span>
								{/if}
							</div>
							<div class="mt-1 flex items-center gap-4 text-xs text-[var(--color-tron-text-secondary)]">
								<span>{tray.totalRuns} runs</span>
								<span>Registered: {new Date(tray.createdAt).toLocaleDateString()}</span>
							</div>
						</div>
						<div class="flex items-center gap-2">
							{#if data.isAdmin && tray.status !== 'Available'}
								<button
									type="button"
									onclick={() => openTrayOverride(tray.trayId)}
									class="rounded border border-red-500/30 px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/20"
								>
									Override
								</button>
							{/if}
							{#if tray.recentRuns.length > 0}
								<button
									type="button"
									onclick={() => toggleTray(tray.trayId)}
									class="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-surface-hover)] hover:text-[var(--color-tron-cyan)]"
								>
									<svg class="h-4 w-4 transition-transform {expandedTray === tray.trayId ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
									History
								</button>
							{/if}
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a href="/spu/equipment/decks-trays/tray?id={tray.trayId}" class="rounded p-1 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
							</a>
						</div>
					</div>

					<!-- Expandable recent run history -->
					{#if expandedTray === tray.trayId && tray.recentRuns.length > 0}
						<div class="border-t border-[var(--color-tron-border)]/50 bg-[var(--color-tron-bg-tertiary)] px-4 py-3">
							<p class="mb-2 text-xs font-medium text-[var(--color-tron-text-secondary)]">Recent Runs (last {tray.recentRuns.length})</p>
							<div class="overflow-x-auto">
								<table class="w-full text-xs">
									<thead>
										<tr class="text-left text-[var(--color-tron-text-secondary)]">
											<th class="pb-1.5 pr-3 font-medium">Run ID</th>
											<th class="pb-1.5 pr-3 font-medium">Status</th>
											<th class="pb-1.5 pr-3 font-medium">Operator</th>
											<th class="pb-1.5 pr-3 font-medium">Robot</th>
											<th class="pb-1.5 pr-3 font-medium">Deck</th>
											<th class="pb-1.5 pr-3 font-medium">Cartridges</th>
											<th class="pb-1.5 pr-3 font-medium">Duration</th>
											<th class="pb-1.5 font-medium">Date</th>
										</tr>
									</thead>
									<tbody>
										{#each tray.recentRuns as run (run.runId)}
											<tr class="border-t border-[var(--color-tron-border)]/30">
												<td class="py-1.5 pr-3 font-mono text-[var(--color-tron-cyan)]">{run.runId}</td>
												<td class="py-1.5 pr-3">
													<span class="inline-flex items-center gap-1">
														<span class="h-1.5 w-1.5 rounded-full {runStatusDot(run.status)}"></span>
														{run.status}
													</span>
												</td>
												<td class="py-1.5 pr-3">{run.operatorName}</td>
												<td class="py-1.5 pr-3 font-mono">{run.robotId}</td>
												<td class="py-1.5 pr-3 font-mono text-[var(--color-tron-text-secondary)]">{run.deckId ?? '-'}</td>
												<td class="py-1.5 pr-3">{run.cartridgeCount}</td>
												<td class="py-1.5 pr-3">{run.durationMinutes != null ? `${run.durationMinutes}m` : '-'}</td>
												<td class="py-1.5 text-[var(--color-tron-text-secondary)]">{new Date(run.date).toLocaleDateString()}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}
				</div>
			{/each}
			{#if data.trays.length === 0}
				<p class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center text-sm text-[var(--color-tron-text-secondary)]">No trays registered.</p>
			{/if}
		</div>
	</section>
</div>
