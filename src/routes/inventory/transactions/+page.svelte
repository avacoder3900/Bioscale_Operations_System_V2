<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';

	interface Props {
		data: {
			transactions: Array<{
				id: string;
				partDefinitionId: string;
				partName: string | null;
				partNumber: string | null;
				transactionType: string;
				quantity: number;
				previousQuantity: number;
				newQuantity: number;
				reason: string | null;
				performedBy: string;
				performedByName: string | null;
				performedAt: string | null;
				assemblySessionId: string | null;
				retractedAt: string | null;
				retractedBy: string | null;
				retractionReason: string | null;
				isRetracted: boolean;
			}>;
			parts: Array<{
				id: string;
				name: string;
				partNumber: string | null;
			}>;
			canRetract: boolean;
			canWithdraw: boolean;
			spuKit: {
				lines: Array<{
					partNumber: string;
					name: string;
					quantity: number;
					components: string[];
					notes: string[];
					partDefinitionId: string | null;
					currentStock: number | null;
					resolved: boolean;
					short: boolean;
				}>;
				totalParts: number;
				totalUnits: number;
				unresolvedCount: number;
				shortageCount: number;
			} | null;
			spus: Array<{
				id: string;
				label: string;
				udi: string;
				barcode: string | null;
				status: string;
				alreadyWithdrawn: boolean;
			}>;
			filters: {
				partId: string | null;
				type: string | null;
				startDate: string | null;
				endDate: string | null;
				retracted: string | null;
			};
		};
	}

	let { data }: Props = $props();

	// Filter state
	let partFilter = $state(data.filters.partId ?? '');
	let typeFilter = $state(data.filters.type ?? '');
	let startDate = $state(data.filters.startDate ?? '');
	let endDate = $state(data.filters.endDate ?? '');
	let retractedFilter = $state(data.filters.retracted ?? '');

	// Retraction modal state
	let showRetractModal = $state(false);
	let retractingTransactionId = $state<string | null>(null);
	let retractReason = $state('');
	let isSubmitting = $state(false);

	// SPU kit withdrawal state
	let showKitModal = $state(false);
	let selectedSpuId = $state('');
	let acknowledgeRepeat = $state(false);
	let isWithdrawing = $state(false);
	let withdrawResult = $state<{
		spuLabel: string;
		withdrawn: Array<{ partNumber: string; name: string; quantity: number; newCount: number }>;
		skipped: Array<{ partNumber: string; name: string; quantity: number; reason: string; notes: string[] }>;
		totalUnits: number;
	} | null>(null);
	let withdrawError = $state<string | null>(null);

	const selectedSpu = $derived(data.spus.find((s) => s.id === selectedSpuId) ?? null);
	const isRepeatWithdrawal = $derived(selectedSpu?.alreadyWithdrawn === true);
	const canConfirmWithdrawal = $derived(
		Boolean(selectedSpuId) && (!isRepeatWithdrawal || acknowledgeRepeat) && !isWithdrawing
	);

	function openKitModal() {
		selectedSpuId = '';
		acknowledgeRepeat = false;
		withdrawResult = null;
		withdrawError = null;
		showKitModal = true;
	}

	function closeKitModal() {
		showKitModal = false;
		withdrawResult = null;
		withdrawError = null;
	}

	function applyFilters() {
		const params = new URLSearchParams();
		if (partFilter) params.set('partId', partFilter);
		if (typeFilter) params.set('type', typeFilter);
		if (startDate) params.set('startDate', startDate);
		if (endDate) params.set('endDate', endDate);
		if (retractedFilter) params.set('retracted', retractedFilter);

		goto(`?${params.toString()}`);
	}

	function clearFilters() {
		partFilter = '';
		typeFilter = '';
		startDate = '';
		endDate = '';
		retractedFilter = '';
		goto('?');
	}

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return '-';
		return new Date(dateStr).toLocaleString();
	}

	function openRetractModal(transactionId: string) {
		retractingTransactionId = transactionId;
		retractReason = '';
		showRetractModal = true;
	}

	function closeRetractModal() {
		showRetractModal = false;
		retractingTransactionId = null;
		retractReason = '';
	}

	function getTypeBadge(type: string, isRetracted: boolean) {
		if (isRetracted) {
			return {
				class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)] line-through',
				label: type
			};
		}
		switch (type) {
			case 'consumption':
				return {
					class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]',
					label: 'Consumption'
				};
			case 'deduction':
				return {
					class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]',
					label: 'Deduction'
				};
			case 'receipt':
				return {
					class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]',
					label: 'Receipt'
				};
			case 'adjustment':
				return {
					class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]',
					label: 'Adjustment'
				};
			default:
				return {
					class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]',
					label: type
				};
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Inventory Transactions</h1>
			<p class="tron-text-muted mt-1">View and manage inventory movements</p>
		</div>
		{#if data.canWithdraw && data.spuKit}
			<button type="button" onclick={openKitModal} class="tron-btn-primary px-4 py-2 text-sm">
				Withdraw SPU Kit
			</button>
		{/if}
	</div>

	<!-- Filters -->
	<div class="tron-card p-4">
		<div class="flex flex-wrap items-end gap-4">
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Part</label>
				<select bind:value={partFilter} class="tron-input min-w-[180px] px-3 py-2 text-sm">
					<option value="">All Parts</option>
					{#each data.parts as part}
						<option value={part.id}>{part.name} ({part.partNumber})</option>
					{/each}
				</select>
			</div>
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Type</label>
				<select bind:value={typeFilter} class="tron-input min-w-[140px] px-3 py-2 text-sm">
					<option value="">All Types</option>
					<option value="deduction">Deduction</option>
					<option value="receipt">Receipt</option>
					<option value="adjustment">Adjustment</option>
				</select>
			</div>
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Start Date</label>
				<input type="date" bind:value={startDate} class="tron-input px-3 py-2 text-sm" />
			</div>
			<div>
				<label class="tron-text-muted mb-1 block text-xs">End Date</label>
				<input type="date" bind:value={endDate} class="tron-input px-3 py-2 text-sm" />
			</div>
			<div>
				<label class="tron-text-muted mb-1 block text-xs">Status</label>
				<select bind:value={retractedFilter} class="tron-input min-w-[120px] px-3 py-2 text-sm">
					<option value="">All</option>
					<option value="no">Active</option>
					<option value="yes">Retracted</option>
				</select>
			</div>
			<button onclick={applyFilters} class="tron-btn-primary px-4 py-2 text-sm">
				Apply Filters
			</button>
			<button onclick={clearFilters} class="tron-btn-secondary px-4 py-2 text-sm"> Clear </button>
		</div>
	</div>

	<!-- Results Table -->
	<div class="tron-card">
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)]">
						<th class="tron-text-muted p-4 text-left font-medium">Date</th>
						<th class="tron-text-muted p-4 text-left font-medium">Part</th>
						<th class="tron-text-muted p-4 text-left font-medium">Type</th>
						<th class="tron-text-muted p-4 text-right font-medium">Qty</th>
						<th class="tron-text-muted p-4 text-right font-medium">Before</th>
						<th class="tron-text-muted p-4 text-right font-medium">After</th>
						<th class="tron-text-muted p-4 text-left font-medium">User</th>
						<th class="tron-text-muted p-4 text-left font-medium">Session</th>
						<th class="tron-text-muted p-4 text-left font-medium"></th>
					</tr>
				</thead>
				<tbody>
					{#each data.transactions as txn (txn.id)}
						{@const badge = getTypeBadge(txn.transactionType, txn.isRetracted)}
						<tr
							class="border-b border-[var(--color-tron-border)] transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
							class:opacity-60={txn.isRetracted}
						>
							<td class="p-4">
								<span class="tron-text-muted text-xs">{formatDate(txn.performedAt)}</span>
							</td>
							<td class="p-4">
								<div class="tron-heading font-medium">{txn.partName ?? 'Unknown'}</div>
								<div class="tron-text-muted text-xs">{txn.partNumber}</div>
							</td>
							<td class="p-4">
								<span class="rounded-full px-2 py-1 text-xs font-medium {badge.class}">
									{badge.label}
								</span>
								{#if txn.isRetracted}
									<div class="tron-text-muted mt-1 text-xs">Retracted</div>
								{/if}
							</td>
							<td class="p-4 text-right">
								<span
									class="font-mono font-medium"
									class:text-[var(--color-tron-red)]={txn.quantity < 0}
									class:text-[var(--color-tron-green)]={txn.quantity > 0}
								>
									{txn.quantity > 0 ? '+' : ''}{txn.quantity}
								</span>
							</td>
							<td class="p-4 text-right">
								<span class="tron-text-muted font-mono">{txn.previousQuantity}</span>
							</td>
							<td class="p-4 text-right">
								<span class="tron-heading font-mono">{txn.newQuantity}</span>
							</td>
							<td class="p-4">
								<span class="tron-text-muted">{txn.performedByName ?? '-'}</span>
							</td>
							<td class="p-4">
								{#if txn.assemblySessionId}
									<a
										href="/assembly/{txn.assemblySessionId}"
										class="text-[var(--color-tron-cyan)] hover:underline"
									>
										View
									</a>
								{:else}
									<span class="tron-text-muted">-</span>
								{/if}
							</td>
							<td class="p-4">
								{#if data.canRetract && !txn.isRetracted && txn.transactionType === 'deduction'}
									<button
										onclick={() => openRetractModal(txn.id)}
										class="text-[var(--color-tron-red)] hover:underline"
									>
										Retract
									</button>
								{:else if txn.isRetracted}
									<button
										class="tron-text-muted cursor-help text-xs"
										title={txn.retractionReason ?? 'Retracted'}
									>
										Info
									</button>
								{/if}
							</td>
						</tr>
						{#if txn.isRetracted && txn.retractionReason}
							<tr class="bg-[var(--color-tron-bg-tertiary)]">
								<td colspan="9" class="px-4 pb-3 pt-0">
									<div class="tron-text-muted text-xs">
										<strong>Retraction reason:</strong>
										{txn.retractionReason}
									</div>
								</td>
							</tr>
						{/if}
					{:else}
						<tr>
							<td colspan="9" class="p-8 text-center">
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
								<p class="tron-text-muted mt-4">No transactions found</p>
								<p class="tron-text-muted mt-1 text-sm">Try adjusting your filters</p>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.transactions.length > 0}
			<div
				class="tron-text-muted border-t border-[var(--color-tron-border)] p-4 text-center text-xs"
			>
				Showing {data.transactions.length} transaction{data.transactions.length !== 1 ? 's' : ''}
			</div>
		{/if}
	</div>
</div>

<!-- Retract Modal -->
{#if showRetractModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div class="tron-card w-full max-w-md p-6">
			<h2 class="tron-heading mb-4 text-lg font-bold">Retract Transaction</h2>
			<p class="tron-text-muted mb-4 text-sm">
				This will restore the inventory and mark the transaction as retracted. This action is
				logged and cannot be undone.
			</p>

			<form
				method="POST"
				action="?/retract"
				use:enhance={() => {
					isSubmitting = true;
					return async ({ result }) => {
						isSubmitting = false;
						if (result.type === 'success') {
							closeRetractModal();
							await invalidateAll();
						}
					};
				}}
			>
				<input type="hidden" name="transactionId" value={retractingTransactionId} />

				<div class="mb-4">
					<label class="tron-text-muted mb-1 block text-sm">Reason for Retraction *</label>
					<textarea
						name="reason"
						bind:value={retractReason}
						rows="3"
						required
						class="tron-input w-full px-3 py-2 text-sm"
						placeholder="Explain why this transaction is being retracted..."
					></textarea>
				</div>

				<div class="flex justify-end gap-3">
					<button
						type="button"
						onclick={closeRetractModal}
						disabled={isSubmitting}
						class="tron-btn-secondary px-4 py-2 text-sm"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={isSubmitting || !retractReason.trim()}
						class="bg-[var(--color-tron-red)] px-4 py-2 text-sm text-white hover:opacity-80 disabled:opacity-50"
					>
						{isSubmitting ? 'Retracting...' : 'Confirm Retraction'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- SPU Kit Withdrawal Modal -->
{#if showKitModal && data.spuKit}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
		<div class="tron-card flex max-h-[90vh] w-full max-w-3xl flex-col p-6">
			{#if withdrawResult}
				<!-- Result view -->
				<h2 class="tron-heading mb-2 text-lg font-bold">Kit Withdrawn</h2>
				<p class="tron-text-muted mb-4 text-sm">
					Deducted {withdrawResult.totalUnits} unit{withdrawResult.totalUnits !== 1 ? 's' : ''} across
					{withdrawResult.withdrawn.length} part{withdrawResult.withdrawn.length !== 1 ? 's' : ''} for SPU
					{withdrawResult.spuLabel}.
				</p>

				{#if withdrawResult.skipped.length > 0}
					<div
						class="mb-4 border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10 p-4"
					>
						<h3 class="mb-2 text-sm font-bold text-[var(--color-tron-yellow)]">
							{withdrawResult.skipped.length} part{withdrawResult.skipped.length !== 1 ? 's' : ''} could
							not be withdrawn
						</h3>
						<ul class="space-y-3">
							{#each withdrawResult.skipped as skip}
								<li class="text-sm">
									<span class="font-mono">{skip.partNumber}</span>
									<span class="tron-text-muted">— {skip.name} (needed {skip.quantity})</span>
									<div class="tron-text-muted mt-1 text-xs">{skip.reason}</div>
									{#each skip.notes as note}
										<div class="mt-1 text-xs text-[var(--color-tron-yellow)]">{note}</div>
									{/each}
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="min-h-0 flex-1 overflow-y-auto border border-[var(--color-tron-border)]">
					<table class="w-full text-sm">
						<thead class="tron-text-muted sticky top-0 bg-[var(--color-tron-bg)] text-left text-xs">
							<tr>
								<th class="p-2">Part</th>
								<th class="p-2">Name</th>
								<th class="p-2 text-right">Withdrawn</th>
								<th class="p-2 text-right">On hand</th>
							</tr>
						</thead>
						<tbody>
							{#each withdrawResult.withdrawn as line}
								<tr class="border-t border-[var(--color-tron-border)]">
									<td class="p-2 font-mono text-xs">{line.partNumber}</td>
									<td class="p-2">{line.name}</td>
									<td class="p-2 text-right">{line.quantity}</td>
									<td class="p-2 text-right {line.newCount < 0 ? 'text-[var(--color-tron-red)]' : ''}">
										{line.newCount}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<div class="mt-4 flex justify-end">
					<button
						type="button"
						onclick={async () => {
							closeKitModal();
							await invalidateAll();
						}}
						class="tron-btn-primary px-4 py-2 text-sm">Done</button
					>
				</div>
			{:else}
				<!-- Confirmation view -->
				<h2 class="tron-heading mb-2 text-lg font-bold">Withdraw SPU Kit</h2>
				<p class="tron-text-muted mb-4 text-sm">
					Deducts the full standard parts kit for one SPU — {data.spuKit.totalParts} parts,
					{data.spuKit.totalUnits} units total. Assembly scans only deduct barcode-scanned parts; this
					books the rest of the build.
				</p>

				{#if withdrawError}
					<div
						class="mb-4 border border-[var(--color-tron-red)]/40 bg-[var(--color-tron-red)]/10 p-3 text-sm text-[var(--color-tron-red)]"
					>
						{withdrawError}
					</div>
				{/if}

				<div class="mb-4">
					<label for="kit-spu" class="tron-text-muted mb-1 block text-sm">SPU *</label>
					<select id="kit-spu" bind:value={selectedSpuId} class="tron-input w-full px-3 py-2 text-sm">
						<option value="">Select an SPU...</option>
						{#each data.spus as spu}
							<option value={spu.id}>
								{spu.label} — {spu.status}{spu.alreadyWithdrawn ? ' (kit already withdrawn)' : ''}
							</option>
						{/each}
					</select>
				</div>

				{#if isRepeatWithdrawal}
					<label
						class="mb-4 flex items-start gap-2 border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10 p-3 text-sm"
					>
						<input type="checkbox" bind:checked={acknowledgeRepeat} class="mt-1" />
						<span>
							A kit has already been withdrawn for this SPU. Withdrawing again will deduct a second
							full kit. Confirm this is intentional.
						</span>
					</label>
				{/if}

				{#if data.spuKit.unresolvedCount > 0 || data.spuKit.shortageCount > 0}
					<div class="tron-text-muted mb-3 text-xs">
						{#if data.spuKit.unresolvedCount > 0}
							<span class="text-[var(--color-tron-yellow)]">
								{data.spuKit.unresolvedCount} part{data.spuKit.unresolvedCount !== 1 ? 's' : ''} cannot
								be deducted (not in the inventory system) — see the notes below.
							</span>
						{/if}
						{#if data.spuKit.shortageCount > 0}
							<span class="ml-2 text-[var(--color-tron-red)]">
								{data.spuKit.shortageCount} part{data.spuKit.shortageCount !== 1 ? 's' : ''} will go short
								on stock.
							</span>
						{/if}
					</div>
				{/if}

				<div class="min-h-0 flex-1 overflow-y-auto border border-[var(--color-tron-border)]">
					<table class="w-full text-sm">
						<thead class="tron-text-muted sticky top-0 bg-[var(--color-tron-bg)] text-left text-xs">
							<tr>
								<th class="p-2">Part</th>
								<th class="p-2">Name</th>
								<th class="p-2 text-right">Qty</th>
								<th class="p-2 text-right">On hand</th>
							</tr>
						</thead>
						<tbody>
							{#each data.spuKit.lines as line}
								<tr class="border-t border-[var(--color-tron-border)]">
									<td class="p-2 align-top font-mono text-xs">{line.partNumber}</td>
									<td class="p-2 align-top">
										{line.name}
										{#if !line.resolved}
											<div class="mt-1 text-xs text-[var(--color-tron-yellow)]">
												Not in the inventory system — will be skipped.
											</div>
										{/if}
										{#each line.notes as note}
											<div class="tron-text-muted mt-1 text-xs italic">{note}</div>
										{/each}
									</td>
									<td class="p-2 text-right align-top">{line.quantity}</td>
									<td
										class="p-2 text-right align-top {!line.resolved
											? 'text-[var(--color-tron-yellow)]'
											: line.short
												? 'text-[var(--color-tron-red)]'
												: ''}"
									>
										{line.resolved ? line.currentStock : '—'}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<form
					method="POST"
					action="?/withdrawSpuKit"
					class="mt-4 flex justify-end gap-3"
					use:enhance={() => {
						isWithdrawing = true;
						withdrawError = null;
						return async ({ result }) => {
							isWithdrawing = false;
							if (result.type === 'success' && result.data?.withdrawal) {
								withdrawResult = result.data.withdrawal as typeof withdrawResult;
							} else if (result.type === 'failure') {
								withdrawError =
									(result.data?.error as string) ?? 'Withdrawal failed. No inventory was changed.';
							} else if (result.type === 'error') {
								withdrawError = result.error?.message ?? 'Withdrawal failed.';
							}
						};
					}}
				>
					<input type="hidden" name="spuRef" value={selectedSpuId} />
					<button
						type="button"
						onclick={closeKitModal}
						disabled={isWithdrawing}
						class="tron-btn-secondary px-4 py-2 text-sm">Cancel</button
					>
					<button type="submit" disabled={!canConfirmWithdrawal} class="tron-btn-primary px-4 py-2 text-sm">
						{isWithdrawing ? 'Withdrawing...' : 'Withdraw Kit'}
					</button>
				</form>
			{/if}
		</div>
	</div>
{/if}
