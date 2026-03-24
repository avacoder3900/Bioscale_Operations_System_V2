<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance } from '$app/forms';
	import InventoryPreview from '$lib/components/production/InventoryPreview.svelte';

	interface PartRequirement {
		id: string;
		partNumber: string;
		quantity: number;
		notes: string | null;
		partDefinitionId: string | null;
		partName: string | null;
		partCategory: string | null;
		partSupplier: string | null;
		unitCost: string | null;
	}

	interface ToolRequirement {
		id: string;
		toolNumber: string;
		toolName: string | null;
		calibrationRequired: boolean;
		notes: string | null;
	}

	interface AvailablePart {
		id: string;
		name: string;
		partNumber: string | null;
	}

	interface Step {
		id: string;
		stepNumber: number;
		title: string | null;
		content: string | null;
		imageData: string | null;
		imageContentType: string | null;
		requiresScan: boolean;
		scanPrompt: string | null;
		notes: string | null;
		partRequirements: PartRequirement[];
		toolRequirements: ToolRequirement[];
		fieldCount: number;
		partDefinitionId: string | null;
		partQuantity: number;
	}

	interface VersionHistory {
		id: string;
		version: number;
		changeNotes: string | null;
		parsedAt: Date | null;
		createdAt: Date;
	}

	interface Unit {
		unitId: string;
		unitIndex: number;
		unitStatus: string;
		spuId: string;
		udi: string;
		startedAt: Date | null;
		completedAt: Date | null;
	}

	interface ActiveRun {
		id: string;
		runNumber: string;
		status: string;
		quantity: number;
		startedAt: Date | null;
		createdAt: Date;
		completedCount: number;
		units: Unit[];
	}

	interface InventoryPartRequirement {
		partNumber: string;
		partName: string;
		partDefinitionId: string;
		requiredTotal: number;
		availableInventory: number;
		shortfall: number;
		status: 'sufficient' | 'insufficient' | 'no_tracking' | 'unlinked';
	}

	interface Props {
		data: {
			workInstruction: {
				documentNumber: string;
				title: string;
				description: string | null;
				documentType: string;
				status: string;
				currentVersion: number;
				originalFileName: string | null;
				fileSize: number | null;
				createdAt: Date;
				updatedAt: Date;
				creatorName: string | null;
			};
			currentVersion: {
				id: string;
				version: number;
				content: string | null;
				changeNotes: string | null;
				parsedAt: Date | null;
				parsedByName: string | null;
			} | null;
			steps: Step[];
			versionHistory: VersionHistory[];
			availableParts: AvailablePart[];
			canEdit: boolean;
			isAdmin: boolean;
			activeRuns: ActiveRun[];
		};
		form: {
			success?: boolean;
			runId?: string;
			workInstructionId?: string;
			error?: string;
			shortfalls?: string[];
			statusChanged?: boolean;
			bulkCancelError?: string;
			bulkCancelled?: boolean;
			cancelledRuns?: number;
			totalRetracted?: number;
			totalUnits?: number;
		} | null;
	}

	let { data, form }: Props = $props();

	// Expandable step list
	let expandedSteps = new SvelteSet<number>();
	let showVersionHistory = $state(false);

	// Production run form state
	let runQuantity = $state(1);
	let runChecking = $state(false);
	let runInventoryResult = $state<{
		requirements: InventoryPartRequirement[];
		allSufficient: boolean;
	} | null>(null);
	let runCheckError = $state<string | null>(null);
	let runSubmitting = $state(false);

	let isActive = $derived(data.workInstruction.status === 'active');

	// Bulk cancel state (admin only)
	let selectMode = $state(false);
	let selectedRunIds = new SvelteSet<string>();
	let showBulkCancelModal = $state(false);
	let bulkCancelReason = $state('');
	let bulkCancelPassword = $state('');
	let bulkCancelling = $state(false);

	// Redirect on successful run creation
	$effect(() => {
		if (form?.success && form.runId && form.workInstructionId) {
			goto(`/documents/instructions/${form.workInstructionId}/run/${form.runId}`);
		}
	});

	// Handle successful bulk cancel
	$effect(() => {
		if (form?.bulkCancelled) {
			showBulkCancelModal = false;
			selectMode = false;
			selectedRunIds.clear();
			bulkCancelReason = '';
			bulkCancelPassword = '';
		}
	});

	async function checkRunInventory() {
		runChecking = true;
		runCheckError = null;
		runInventoryResult = null;

		try {
			const res = await fetch('/documents/instructions/check-inventory', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workInstructionId: $page.params.id,
					quantity: runQuantity
				})
			});

			if (!res.ok) {
				const err = await res.json();
				runCheckError = err.error || 'Failed to check inventory';
				return;
			}

			runInventoryResult = await res.json();
		} catch {
			runCheckError = 'Network error checking inventory';
		} finally {
			runChecking = false;
		}
	}

	function resetRunForm() {
		runInventoryResult = null;
		runCheckError = null;
	}

	function toggleRunSelection(runId: string) {
		if (selectedRunIds.has(runId)) {
			selectedRunIds.delete(runId);
		} else {
			selectedRunIds.add(runId);
		}
	}

	function selectAllRuns() {
		data.activeRuns.forEach((r) => selectedRunIds.add(r.id));
	}

	function deselectAllRuns() {
		selectedRunIds.clear();
	}

	function toggleStep(stepNum: number) {
		if (expandedSteps.has(stepNum)) {
			expandedSteps.delete(stepNum);
		} else {
			expandedSteps.add(stepNum);
		}
	}

	function expandAll() {
		data.steps.forEach((s) => expandedSteps.add(s.stepNumber));
	}

	function collapseAll() {
		expandedSteps.clear();
	}

	function formatDate(date: Date | null): string {
		if (!date) return 'N/A';
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function getStatusColor(status: string): string {
		switch (status) {
			case 'active':
				return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
			case 'draft':
				return 'bg-[var(--color-tron-yellow)]/20 text-[var(--color-tron-yellow)]';
			case 'archived':
				return 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]';
			default:
				return 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]';
		}
	}

	function getRunStatusLabel(status: string): string {
		switch (status) {
			case 'in_progress':
				return 'In Progress';
			case 'paused':
				return 'Paused';
			case 'approved':
				return 'Ready';
			default:
				return status;
		}
	}

	function getRunStatusColor(status: string): string {
		switch (status) {
			case 'in_progress':
				return 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]';
			case 'paused':
				return 'bg-[var(--color-tron-orange)]/20 text-[var(--color-tron-orange)]';
			case 'approved':
				return 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]';
			default:
				return 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)]';
		}
	}

	function getUnitStatusColor(status: string): string {
		switch (status) {
			case 'completed':
				return 'text-[var(--color-tron-green)]';
			case 'in_progress':
				return 'text-[var(--color-tron-cyan)]';
			default:
				return 'text-[var(--color-tron-text-secondary)]';
		}
	}

	function getUnitStatusBg(status: string): string {
		switch (status) {
			case 'completed':
				return 'border-[var(--color-tron-green)] bg-[color-mix(in_srgb,var(--color-tron-green)_8%,transparent)]';
			case 'in_progress':
				return 'border-[var(--color-tron-cyan)] bg-[color-mix(in_srgb,var(--color-tron-cyan)_8%,transparent)]';
			default:
				return 'border-[var(--color-tron-border)]';
		}
	}
</script>

<svelte:head>
	<title>{data.workInstruction.documentNumber} | Work Instructions</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				<a
					href={resolve('/documents/instructions')}
					class="tron-text-muted hover:text-[var(--color-tron-cyan)]"
					aria-label="Back to work instructions"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M15 19l-7-7 7-7"
						/>
					</svg>
				</a>
				<h1 class="tron-heading text-2xl font-bold">
					{data.workInstruction.documentNumber}
				</h1>
				<span
					class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize {getStatusColor(
						data.workInstruction.status
					)}"
				>
					{data.workInstruction.status}
				</span>
			</div>
			<p class="tron-text-primary mt-1">{data.workInstruction.title}</p>
		</div>
		<div class="flex items-center gap-2">
			{#if data.canEdit}
				{#if data.workInstruction.status === 'draft'}
					<form method="POST" action="?/changeStatus" use:enhance>
						<input type="hidden" name="status" value="active" />
						<button type="submit" class="rounded-lg bg-[var(--color-tron-green)] px-4 py-2 text-sm font-medium text-black transition-all hover:brightness-110" style="min-height: 44px;">
							Activate
						</button>
					</form>
				{:else if data.workInstruction.status === 'active'}
					<form method="POST" action="?/changeStatus" use:enhance>
						<input type="hidden" name="status" value="archived" />
						<button type="submit" class="tron-btn-secondary text-sm" style="min-height: 44px;">
							Archive
						</button>
					</form>
				{:else if data.workInstruction.status === 'archived'}
					<form method="POST" action="?/changeStatus" use:enhance>
						<input type="hidden" name="status" value="active" />
						<button type="submit" class="rounded-lg bg-[var(--color-tron-green)] px-4 py-2 text-sm font-medium text-black transition-all hover:brightness-110" style="min-height: 44px;">
							Reactivate
						</button>
					</form>
				{/if}
			{/if}
			<a
				href={resolve(`/documents/instructions/${$page.params.id}/fields`)}
				class="tron-btn-secondary flex items-center gap-2 text-sm"
				style="min-height: 44px;"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
				</svg>
				Configure Fields
			</a>
		</div>
	</div>

	<!-- ============================================ -->
	<!-- Start Production Run (active WIs only)       -->
	<!-- ============================================ -->
	{#if isActive}
		<div class="tron-card p-6">
			<h2 class="tron-heading text-xl font-bold text-center mb-1">
				How many would you like to make?
			</h2>
			<p class="tron-text-muted text-center text-sm mb-4">
				Enter the number of units and check inventory before starting.
			</p>

			<div class="flex items-center justify-center gap-3 mb-4">
				<input
					id="run-quantity"
					type="number"
					min="1"
					max="100"
					bind:value={runQuantity}
					class="tron-input text-center text-2xl font-bold"
					style="width: 120px;"
					oninput={resetRunForm}
					onkeydown={(e) => {
						if (e.key === 'Enter') checkRunInventory();
					}}
				/>
				<button
					onclick={checkRunInventory}
					disabled={runChecking || runQuantity < 1 || runQuantity > 100}
					class="tron-btn-primary"
					style="min-height: 48px; font-size: 1rem; background-color: var(--color-tron-green); border-color: var(--color-tron-green); border-radius: 8px; box-shadow: 0 0 8px var(--color-tron-green), 0 0 20px rgba(0, 255, 136, 0.3); text-shadow: 0 0 6px rgba(0, 255, 136, 0.6);"
				>
					{runChecking ? 'Checking...' : 'Check Inventory'}
				</button>
			</div>

			{#if runCheckError}
				<p class="text-sm text-[var(--color-tron-red)] text-center mb-2">{runCheckError}</p>
			{/if}

			{#if runInventoryResult}
				<InventoryPreview
					requirements={runInventoryResult.requirements}
					allSufficient={runInventoryResult.allSufficient}
				/>

				{#if runInventoryResult.allSufficient}
					<form
						method="POST"
						action="?/createRun"
						class="mt-4"
						use:enhance={() => {
							runSubmitting = true;
							return async ({ update }) => {
								runSubmitting = false;
								await update();
							};
						}}
					>
						<input type="hidden" name="quantity" value={runQuantity} />
						<button
							type="submit"
							disabled={runSubmitting}
							class="start-btn"
						>
							{runSubmitting ? 'Creating...' : 'Start Production Run'}
						</button>
					</form>
				{/if}
			{/if}

			{#if form?.error && !form?.success && !form?.statusChanged}
				<p class="text-sm text-[var(--color-tron-red)] text-center mt-2">{form.error}</p>
				{#if form.shortfalls}
					<ul class="mt-1 pl-5 font-mono text-xs text-[var(--color-tron-red)]">
						{#each form.shortfalls as s, i (i)}
							<li>{s}</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>
	{/if}

	<!-- ============================================ -->
	<!-- Active Production Runs                       -->
	<!-- ============================================ -->
	{#if data.activeRuns.length > 0}
		<div class="space-y-4">
			<div class="flex items-center justify-between">
				<h2 class="tron-heading text-lg font-semibold">Active Production Runs</h2>
				{#if data.isAdmin}
					<div class="flex items-center gap-2">
						{#if selectMode && selectedRunIds.size > 0}
							<button
								onclick={() => (showBulkCancelModal = true)}
								class="rounded-lg bg-[var(--color-tron-red)] px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110"
								style="min-height: 44px;"
							>
								Cancel Selected ({selectedRunIds.size})
							</button>
						{/if}
						<button
							onclick={() => {
								selectMode = !selectMode;
								if (!selectMode) selectedRunIds.clear();
							}}
							class="tron-btn-secondary text-sm"
							style="min-height: 44px;"
						>
							{selectMode ? 'Done' : 'Manage Runs'}
						</button>
					</div>
				{/if}
			</div>

			{#if selectMode && data.isAdmin}
				<div class="flex items-center gap-3">
					<button onclick={selectAllRuns} class="tron-btn-ghost text-sm">Select All</button>
					<button onclick={deselectAllRuns} class="tron-btn-ghost text-sm">Deselect All</button>
					<span class="tron-text-muted text-sm">{selectedRunIds.size} of {data.activeRuns.length} selected</span>
				</div>
			{/if}

			{#if form?.bulkCancelled}
				<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,102,0.1)] p-3">
					<p class="text-sm text-[var(--color-tron-green)]">
						Cancelled {form.cancelledRuns} run(s). {form.totalUnits} units reset, {form.totalRetracted} inventory transactions retracted.
					</p>
				</div>
			{/if}

			{#each data.activeRuns as run (run.id)}
				<div class="run-section {selectMode && selectedRunIds.has(run.id) ? 'run-section-selected' : ''}">
					<div class="run-header">
						<div class="flex items-center gap-3">
							{#if selectMode && data.isAdmin}
								<input
									type="checkbox"
									checked={selectedRunIds.has(run.id)}
									onchange={() => toggleRunSelection(run.id)}
									class="bulk-cancel-checkbox"
									style="min-width: 20px; min-height: 20px;"
								/>
							{/if}
							<span class="font-mono text-lg font-bold text-[var(--color-tron-cyan)]">
								{run.runNumber}
							</span>
							<span
								class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize {getRunStatusColor(
									run.status
								)}"
							>
								{getRunStatusLabel(run.status)}
							</span>
						</div>
						<p class="tron-text-muted mt-0.5 text-xs">
							{run.completedCount} of {run.quantity} units complete
						</p>
						{#if data.isAdmin && !selectMode}
							<a
								href="/documents/instructions/{$page.params.id}/run/{run.id}?cancel=true"
								class="cancel-run-link"
							>
								Cancel Run
							</a>
						{/if}
					</div>

					<div class="unit-grid">
						{#each run.units as unit (unit.unitId)}
							<button
								class="unit-card {getUnitStatusBg(unit.unitStatus)}"
								onclick={() =>
									goto(
										`/documents/instructions/${$page.params.id}/run/${run.id}`
									)}
							>
								<div class="unit-udi">{unit.udi}</div>
								<div class="unit-label">Unit {unit.unitIndex}</div>
								<div class="unit-status {getUnitStatusColor(unit.unitStatus)}">
									{#if unit.unitStatus === 'completed'}
										Completed
									{:else if unit.unitStatus === 'in_progress'}
										In Progress
									{:else}
										Pending
									{/if}
								</div>
							</button>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- ============================================ -->
	<!-- Bulk Cancel Confirmation Modal               -->
	<!-- ============================================ -->
	{#if showBulkCancelModal}
		<div class="modal-overlay" role="dialog" aria-modal="true">
			<div class="modal-content">
				<h3 class="tron-heading text-lg font-bold mb-4">Cancel Production Runs</h3>
				<p class="tron-text-muted text-sm mb-3">
					You are about to cancel {selectedRunIds.size} production run(s):
				</p>
				<ul class="mb-4 space-y-1">
					{#each data.activeRuns.filter((r) => selectedRunIds.has(r.id)) as run (run.id)}
						<li class="font-mono text-sm text-[var(--color-tron-red)]">
							{run.runNumber} ({run.completedCount}/{run.quantity} units)
						</li>
					{/each}
				</ul>

				<form
					method="POST"
					action="?/bulkCancelRuns"
					use:enhance={() => {
						bulkCancelling = true;
						return async ({ update }) => {
							bulkCancelling = false;
							await update();
						};
					}}
				>
					<input type="hidden" name="runIds" value={JSON.stringify([...selectedRunIds])} />

					<div class="mb-4">
						<label for="bulk-cancel-reason" class="tron-label">Cancellation Reason</label>
						<textarea
							id="bulk-cancel-reason"
							name="reason"
							class="tron-input"
							placeholder="Describe reason for cancellation..."
							required
							disabled={bulkCancelling}
							bind:value={bulkCancelReason}
							rows="3"
							style="min-height: 44px;"
						></textarea>
					</div>

					<div class="mb-4">
						<label for="bulk-cancel-password" class="tron-label">Password (e-signature)</label>
						<input
							id="bulk-cancel-password"
							name="password"
							type="password"
							class="tron-input"
							placeholder="Enter your password to confirm"
							required
							disabled={bulkCancelling}
							bind:value={bulkCancelPassword}
							style="min-height: 44px;"
						/>
					</div>

					{#if form?.bulkCancelError}
						<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3 mb-4">
							<p class="text-sm text-[var(--color-tron-red)]">{form.bulkCancelError}</p>
						</div>
					{/if}

					<div class="flex gap-3">
						<button
							type="button"
							class="tron-btn-secondary flex-1"
							onclick={() => {
								showBulkCancelModal = false;
								bulkCancelReason = '';
								bulkCancelPassword = '';
							}}
							disabled={bulkCancelling}
							style="min-height: 44px;"
						>
							Go Back
						</button>
						<button
							type="submit"
							class="flex-1 rounded-lg bg-[var(--color-tron-red)] px-4 py-2 font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
							disabled={bulkCancelling || !bulkCancelReason || !bulkCancelPassword}
							style="min-height: 44px;"
						>
							{bulkCancelling ? 'Cancelling...' : `Confirm Cancel (${selectedRunIds.size})`}
						</button>
					</div>
				</form>
			</div>
		</div>
	{/if}

	<!-- ============================================ -->
	<!-- Document Info & Steps                        -->
	<!-- ============================================ -->
	<div class="grid grid-cols-4 gap-4">
		<div class="tron-card p-4">
			<p class="tron-text-muted text-sm">Version</p>
			<p class="tron-heading mt-1 text-xl font-bold">
				v{data.currentVersion?.version || data.workInstruction.currentVersion}
			</p>
		</div>
		<div class="tron-card p-4">
			<p class="tron-text-muted text-sm">Steps</p>
			<p class="tron-heading mt-1 text-xl font-bold">{data.steps.length}</p>
		</div>
		<div class="tron-card p-4">
			<p class="tron-text-muted text-sm">Parts Referenced</p>
			<p class="mt-1 text-xl font-bold text-[var(--color-tron-cyan)]">
				{data.steps.reduce((acc, s) => acc + s.partRequirements.length, 0)}
			</p>
		</div>
		<div class="tron-card p-4">
			<p class="tron-text-muted text-sm">Tools Required</p>
			<p class="mt-1 text-xl font-bold text-[var(--color-tron-yellow)]">
				{data.steps.reduce((acc, s) => acc + s.toolRequirements.length, 0)}
			</p>
		</div>
	</div>

	<div class="grid grid-cols-3 gap-6">
		<!-- Steps Section -->
		<div class="col-span-2 space-y-4">
			<div class="flex items-center justify-between">
				<h2 class="tron-heading text-lg font-semibold">Work Instruction Steps</h2>
				{#if data.steps.length > 0}
					<div class="flex gap-2">
						<button onclick={expandAll} class="tron-btn-ghost text-sm">Expand All</button>
						<button onclick={collapseAll} class="tron-btn-ghost text-sm">Collapse All</button>
					</div>
				{/if}
			</div>

			{#if data.steps.length === 0}
				<div class="tron-card p-8 text-center">
					<svg
						class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
						/>
					</svg>
					<p class="tron-text-muted mt-4">No steps parsed from this document</p>
					<p class="tron-text-muted mt-1 text-sm">
						This may be a general document without structured steps
					</p>
				</div>
			{:else}
				{#each data.steps as step (step.id)}
					{@const isExpanded = expandedSteps.has(step.stepNumber)}
					<div class="tron-card overflow-hidden">
						<button
							onclick={() => toggleStep(step.stepNumber)}
							class="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
						>
							<div class="flex items-center gap-4">
								<div
									class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-tron-cyan)]/20 text-sm font-bold text-[var(--color-tron-cyan)]"
								>
									{step.stepNumber}
								</div>
								<div>
									<p class="tron-text-primary font-medium">
										{step.title || `Step ${step.stepNumber}`}
									</p>
									<div class="mt-1 flex items-center gap-3">
										{#if step.partRequirements.length > 0}
											<span class="text-xs text-[var(--color-tron-cyan)]">
												{step.partRequirements.length} part{step.partRequirements.length !== 1 ? 's' : ''}
											</span>
										{/if}
										{#if step.toolRequirements.length > 0}
											<span class="text-xs text-[var(--color-tron-yellow)]">
												{step.toolRequirements.length} tool{step.toolRequirements.length !== 1 ? 's' : ''}
											</span>
										{/if}
										{#if step.requiresScan}
											<span class="text-xs text-[var(--color-tron-green)]">
												Scan required
											</span>
										{/if}
									</div>
								</div>
							</div>
							<svg
								class="h-5 w-5 text-[var(--color-tron-text-secondary)] transition-transform {isExpanded ? 'rotate-180' : ''}"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
							</svg>
						</button>

						{#if isExpanded}
							<div class="border-t border-[var(--color-tron-border)] p-4">
								{#if step.content}
									<div class="prose max-w-none prose-invert">
										<p class="tron-text-secondary whitespace-pre-wrap">{step.content}</p>
									</div>
								{/if}

								{#if step.requiresScan && step.scanPrompt}
									<div class="mt-4 rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-3">
										<div class="flex items-center gap-2">
											<svg class="h-5 w-5 text-[var(--color-tron-green)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
											</svg>
											<span class="text-sm font-medium text-[var(--color-tron-green)]">{step.scanPrompt}</span>
										</div>
									</div>
								{/if}

								{#if step.partRequirements.length > 0}
									<div class="mt-4">
										<h4 class="tron-text-muted mb-2 text-sm font-medium">Required Parts</h4>
										<div class="space-y-2">
											{#each step.partRequirements as part (part.id)}
												<div class="flex items-center justify-between rounded-lg bg-[var(--color-tron-bg-tertiary)] p-3">
													<div class="flex items-center gap-3">
														<span class="font-mono text-sm text-[var(--color-tron-cyan)]">{part.partNumber}</span>
														{#if part.partName}
															<span class="tron-text-primary">{part.partName}</span>
														{/if}
													</div>
													<span class="tron-text-muted text-sm">Qty: {part.quantity}</span>
												</div>
											{/each}
										</div>
									</div>
								{/if}

								{#if step.toolRequirements.length > 0}
									<div class="mt-4">
										<h4 class="tron-text-muted mb-2 text-sm font-medium">Required Tools</h4>
										<div class="space-y-2">
											{#each step.toolRequirements as tool (tool.id)}
												<div class="flex items-center justify-between rounded-lg bg-[var(--color-tron-bg-tertiary)] p-3">
													<div class="flex items-center gap-3">
														<span class="font-mono text-sm text-[var(--color-tron-yellow)]">{tool.toolNumber}</span>
														{#if tool.toolName}
															<span class="tron-text-primary">{tool.toolName}</span>
														{/if}
													</div>
												</div>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>

		<!-- Sidebar -->
		<div class="space-y-4">
			<!-- Document Info -->
			<div class="tron-card p-4">
				<h3 class="tron-heading mb-4 font-semibold">Document Info</h3>
				<dl class="space-y-3 text-sm">
					<div>
						<dt class="tron-text-muted">Document Number</dt>
						<dd class="tron-text-primary font-mono">{data.workInstruction.documentNumber}</dd>
					</div>
					<div>
						<dt class="tron-text-muted">Type</dt>
						<dd class="tron-text-primary capitalize">{data.workInstruction.documentType.replace('_', ' ')}</dd>
					</div>
					<div>
						<dt class="tron-text-muted">Original File</dt>
						<dd class="tron-text-primary truncate" title={data.workInstruction.originalFileName}>
							{data.workInstruction.originalFileName || 'N/A'}
						</dd>
					</div>
					<div>
						<dt class="tron-text-muted">Created</dt>
						<dd class="tron-text-primary">{formatDate(data.workInstruction.createdAt)}</dd>
					</div>
				</dl>
			</div>

			<!-- Version History -->
			<div class="tron-card p-4">
				<button onclick={() => (showVersionHistory = !showVersionHistory)} class="flex w-full items-center justify-between">
					<h3 class="tron-heading font-semibold">Version History</h3>
					<svg
						class="h-5 w-5 text-[var(--color-tron-text-secondary)] transition-transform {showVersionHistory ? 'rotate-180' : ''}"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
					</svg>
				</button>

				{#if showVersionHistory}
					<div class="mt-4 space-y-3">
						{#each data.versionHistory as version (version.id)}
							<div
								class="rounded-lg border border-[var(--color-tron-border)] p-3 {version.version === data.currentVersion?.version
									? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/5'
									: ''}"
							>
								<div class="flex items-center justify-between">
									<span class="font-medium text-[var(--color-tron-cyan)]">v{version.version}</span>
									{#if version.version === data.currentVersion?.version}
										<span class="rounded bg-[var(--color-tron-cyan)]/20 px-2 py-0.5 text-xs text-[var(--color-tron-cyan)]">Current</span>
									{/if}
								</div>
								{#if version.changeNotes}
									<p class="tron-text-muted mt-1 text-sm">{version.changeNotes}</p>
								{/if}
								<p class="tron-text-muted mt-1 text-xs">{formatDate(version.parsedAt || version.createdAt)}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	/* ========= Start Production Run ========= */
	.start-btn {
		width: 100%;
		min-height: 52px;
		padding: 0.75rem 1rem;
		font-size: 1.125rem;
		font-weight: 700;
		color: var(--color-tron-bg-primary);
		background: var(--color-tron-green);
		border: none;
		border-radius: 0.5rem;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.start-btn:hover {
		opacity: 0.9;
	}

	.start-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ========= Active Runs ========= */
	.run-section {
		background: var(--color-tron-bg-secondary);
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		padding: 1.25rem;
	}

	.run-header {
		margin-bottom: 1rem;
	}

	.unit-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 0.75rem;
	}

	.unit-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		padding: 1rem;
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		cursor: pointer;
		transition: all 0.15s;
		min-height: 44px;
		text-align: center;
		background: var(--color-tron-bg-primary);
	}

	.unit-card:hover {
		border-color: var(--color-tron-cyan);
		background: color-mix(in srgb, var(--color-tron-cyan) 10%, transparent);
		transform: translateY(-1px);
	}

	.unit-udi {
		font-family: monospace;
		font-size: 0.875rem;
		font-weight: 700;
		color: var(--color-tron-text-primary);
		word-break: break-all;
	}

	.unit-label {
		font-size: 0.75rem;
		color: var(--color-tron-text-secondary);
	}

	.unit-status {
		font-size: 0.75rem;
		font-weight: 600;
	}

	/* ========= Check Inventory Neon Button ========= */
	:global(.check-inventory-btn) {
		transition: box-shadow 0.3s ease, text-shadow 0.3s ease, transform 0.15s ease;
	}

	:global(.check-inventory-btn:hover:not(:disabled)) {
		box-shadow: 0 0 12px var(--color-tron-green), 0 0 30px rgba(0, 255, 136, 0.5), 0 0 50px rgba(0, 255, 136, 0.2) !important;
		text-shadow: 0 0 10px rgba(0, 255, 136, 0.9) !important;
		transform: scale(1.02);
	}

	:global(.check-inventory-btn:active:not(:disabled)) {
		box-shadow: 0 0 6px var(--color-tron-green), 0 0 15px rgba(0, 255, 136, 0.4) !important;
		transform: scale(0.98);
	}

	:global(.check-inventory-btn:disabled) {
		box-shadow: none !important;
		text-shadow: none !important;
		opacity: 0.5;
	}

	/* Cancel run link on active run cards */
	.cancel-run-link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-tron-red);
		text-decoration: none;
	}

	.cancel-run-link:hover {
		text-decoration: underline;
	}

	/* ========= Bulk Cancel ========= */
	.run-section-selected {
		border-color: var(--color-tron-red);
		background: color-mix(in srgb, var(--color-tron-red) 5%, var(--color-tron-bg-secondary));
	}

	.bulk-cancel-checkbox {
		accent-color: var(--color-tron-red);
		cursor: pointer;
	}

	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.7);
		backdrop-filter: blur(4px);
	}

	.modal-content {
		background: var(--color-tron-bg-secondary);
		border: 1px solid var(--color-tron-red);
		border-radius: 0.75rem;
		padding: 1.5rem;
		width: 100%;
		max-width: 480px;
		max-height: 80vh;
		overflow-y: auto;
	}
</style>
