<script lang="ts">
	import { enhance } from '$app/forms';

	interface ProcessStep {
		id: string;
		configId: string;
		stepNumber: number;
		title: string;
		description: string | null;
		imageUrl: string | null;
	}

	interface StepEntry {
		id: string;
		lotId: string;
		stepId: string | null;
		note: string | null;
		imageUrl: string | null;
		operatorId: string;
		operatorName: string;
		createdAt: string;
	}

	interface RecentLot {
		lotId: string;
		quantityProduced: number;
		operatorName: string;
		status: string;
		createdAt: string;
		finishTime: string | null;
	}

	interface Props {
		data: {
			config: {
				configId: string;
				processName: string;
				maxBatchSize: number;
				handoffPrompt: string;
				inputMaterials: { partId: string; name: string; scanOrder: number }[];
			} | null;
			processSteps: ProcessStep[];
			lotStepEntries: StepEntry[];
			recentLots: RecentLot[];
			inventory: {
				cutThermosealStrips: { name: string; quantity: number; unit: string };
				rawCartridges: { name: string; quantity: number; unit: string };
				barcodeLabels: { name: string; quantity: number; unit: string };
				individualBacks: { name: string; quantity: number; unit: string };
			};
			error?: string;
		};
		form: {
			bindQR?: { success?: boolean; lotId?: string; error?: string };
			setInputLots?: { success?: boolean; error?: string };
			startBatch?: { success?: boolean; error?: string };
			finishBatch?: { success?: boolean; handoffPrompt?: string; lotId?: string; error?: string };
			addNote?: { success?: boolean; entries?: StepEntry[]; error?: string };
			loadEntries?: { success?: boolean; entries?: StepEntry[]; error?: string };
			addBatchNote?: { success?: boolean; batchNotes?: StepEntry[]; error?: string };
			resumeLot?: { success?: boolean; lotId?: string; resumeStep?: string; entries?: StepEntry[]; error?: string };
		};
	}

	let { data, form }: Props = $props();

	let qrCodeRef = $state('');
	let input1 = $state('');
	let input2 = $state('');
	let input3 = $state('');
	let lotId = $state((form?.bindQR as { lotId?: string } | undefined)?.lotId ?? '');
	let quantity = $state(1);
	let step = $state<'qr' | 'inputs' | 'start' | 'work' | 'finish'>('qr');
	let handoffOpen = $state(!!form?.finishBatch?.success);
	let handoffPrompt = $state((form?.finishBatch as { handoffPrompt?: string } | undefined)?.handoffPrompt ?? '');

	// Operator entries state (updated via form actions)
	let entries = $state<StepEntry[]>(data.lotStepEntries ?? []);

	// Note form state per step
	let activeNoteStep = $state<string | null>(null);
	let noteText = $state('');

	// Batch-level notes state
	let batchNotes = $state<StepEntry[]>([]);
	let batchNoteText = $state('');
	let showBatchNoteForm = $state(false);

	$effect(() => {
		if (form?.bindQR && (form.bindQR as { success?: boolean; lotId?: string }).success && (form.bindQR as { lotId?: string }).lotId) {
			lotId = (form.bindQR as { lotId: string }).lotId;
			step = 'inputs';
		}
		if (form?.setInputLots && (form.setInputLots as { success?: boolean }).success) step = 'start';
		if (form?.startBatch && (form.startBatch as { success?: boolean }).success) step = 'work';
		if (form?.finishBatch && (form.finishBatch as { success?: boolean }).success) {
			handoffPrompt = (form.finishBatch as { handoffPrompt?: string }).handoffPrompt ?? '';
			handoffOpen = true;
		}
		if (form?.addNote && (form.addNote as { entries?: StepEntry[] }).entries) {
			entries = (form.addNote as { entries: StepEntry[] }).entries;
			activeNoteStep = null;
			noteText = '';
		}
		if (form?.loadEntries && (form.loadEntries as { entries?: StepEntry[] }).entries) {
			entries = (form.loadEntries as { entries: StepEntry[] }).entries;
		}
		if (form?.addBatchNote && (form.addBatchNote as { batchNotes?: StepEntry[] }).batchNotes) {
			batchNotes = (form.addBatchNote as { batchNotes: StepEntry[] }).batchNotes;
			batchNoteText = '';
			showBatchNoteForm = false;
		}
		if (form?.resumeLot && (form.resumeLot as { success?: boolean }).success) {
			const r = form.resumeLot as { lotId: string; resumeStep: string; entries: StepEntry[] };
			lotId = r.lotId;
			step = r.resumeStep as typeof step;
			entries = r.entries ?? [];
		}
	});

	function entriesForStep(stepId: string): StepEntry[] {
		return entries.filter((e) => e.stepId === stepId);
	}

	function formatTime(dateStr: string): string {
		return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	// --- Test barcode generators (local only, not stored) ---
	function randomHex(len: number): string {
		return Array.from(crypto.getRandomValues(new Uint8Array(len)))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase()
			.slice(0, len);
	}

	function generateQR() {
		qrCodeRef = `QR-${randomHex(8)}`;
	}

	function generateCartridge() {
		input1 = `CART-${randomHex(6)}`;
	}

	function generateThermoseal() {
		input2 = `TSEAL-${randomHex(6)}`;
	}

	function generateBarcode() {
		input3 = `LBL-${randomHex(6)}`;
	}
</script>

{#if data.error || !data.config}
	<p class="text-[var(--color-tron-error)]">{data.error ?? 'Config not found'}</p>
{:else}
	<div class="space-y-6">
		<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">{data.config.processName}</h1>

		<!-- Inventory Counts -->
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.rawCartridges.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">
					{data.inventory.rawCartridges.quantity}
					<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">{data.inventory.rawCartridges.unit}</span>
				</p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.cutThermosealStrips.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">
					{data.inventory.cutThermosealStrips.quantity}
					<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">{data.inventory.cutThermosealStrips.unit}</span>
				</p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
				<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">{data.inventory.barcodeLabels.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-text)]">
					{data.inventory.barcodeLabels.quantity}
					<span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">{data.inventory.barcodeLabels.unit}</span>
				</p>
			</div>
			<div class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-cyan)]/5 p-4">
				<p class="text-xs font-medium text-[var(--color-tron-cyan)]/70">{data.inventory.individualBacks.name}</p>
				<p class="mt-1 text-2xl font-bold text-[var(--color-tron-cyan)]">
					{data.inventory.individualBacks.quantity}
					<span class="text-sm font-normal text-[var(--color-tron-cyan)]/70">{data.inventory.individualBacks.unit}</span>
				</p>
			</div>
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			{#if step === 'qr'}
				<form method="POST" action="?/bindQR" use:enhance>
					<label class="block text-sm font-medium text-[var(--color-tron-text)]">Scan QR code</label>
					<div class="mt-1 flex gap-2">
						<input
							type="text"
							name="qrCodeRef"
							bind:value={qrCodeRef}
							class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]"
							placeholder="QR code ref"
						/>
						<button type="button" onclick={generateQR} class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]" title="Generate test QR">Test</button>
					</div>
					{#if form?.bindQR && (form.bindQR as { error?: string }).error}
						<p class="mt-1 text-sm text-[var(--color-tron-error)]">{(form.bindQR as { error: string }).error}</p>
					{/if}
					<button
						type="submit"
						class="mt-3 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-[var(--color-tron-bg-primary)]"
					>
						Bind QR
					</button>
				</form>

				<!-- In-Progress Lots -->
				{#each data.recentLots.filter((l) => l.status === 'In Progress') as ipLot (ipLot.lotId)}
					<div class="mt-4 rounded-lg border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/5 p-3">
						<div class="flex items-center justify-between">
							<div>
								<span class="font-mono text-sm text-[var(--color-tron-yellow)]">{ipLot.lotId}</span>
								<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">{ipLot.operatorName}</span>
								<span class="ml-2 text-xs text-[var(--color-tron-text-secondary)]">{new Date(ipLot.createdAt).toLocaleString()}</span>
							</div>
							<form method="POST" action="?/resumeLot" use:enhance>
								<input type="hidden" name="lotId" value={ipLot.lotId} />
								<button type="submit" class="rounded border border-[var(--color-tron-yellow)]/50 bg-[var(--color-tron-yellow)]/20 px-4 py-2 text-sm font-medium text-[var(--color-tron-yellow)] hover:bg-[var(--color-tron-yellow)]/30">
									Resume
								</button>
							</form>
						</div>
					</div>
				{/each}

				<!-- Recent Batches -->
				{#if data.recentLots.length > 0}
					<div class="mt-6 border-t border-[var(--color-tron-border)] pt-4">
						<h2 class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Recent Batches</h2>
						<div class="mt-2 overflow-x-auto">
							<table class="w-full text-left text-sm">
								<thead>
									<tr class="border-b border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)]">
										<th class="px-3 py-2">Lot ID</th>
										<th class="px-3 py-2">Qty</th>
										<th class="px-3 py-2">Operator</th>
										<th class="px-3 py-2">Status</th>
										<th class="px-3 py-2">Time</th>
									</tr>
								</thead>
								<tbody>
									{#each data.recentLots as lot (lot.lotId)}
										<tr class="border-b border-[var(--color-tron-border)]">
											<td class="px-3 py-2">
												<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
												<a
													href="/spu/manufacturing/lots/{lot.lotId}"
													class="text-[var(--color-tron-cyan)] hover:underline"
												>
													{lot.lotId}
												</a>
											</td>
											<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.quantityProduced}</td>
											<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.operatorName}</td>
											<td class="px-3 py-2 text-[var(--color-tron-text)]">{lot.status}</td>
											<td class="px-3 py-2 text-[var(--color-tron-text-secondary)]">
												{lot.finishTime
													? new Date(lot.finishTime).toLocaleString()
													: new Date(lot.createdAt).toLocaleString()}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{/if}
			{:else if step === 'inputs'}
				<form method="POST" action="?/setInputLots" use:enhance>
					<input type="hidden" name="lotId" value={lotId} />
					<p class="text-sm text-[var(--color-tron-text-secondary)]">Lot: {lotId}</p>
					<div class="mt-3 space-y-2">
						<label class="block text-sm text-[var(--color-tron-text)]">{data.config.inputMaterials[0].name}</label>
						<div class="flex gap-2">
							<input type="text" name="input1" bind:value={input1} class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]" />
							<button type="button" onclick={generateCartridge} class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]" title="Generate test barcode">Test</button>
						</div>
						<label class="block text-sm text-[var(--color-tron-text)]">{data.config.inputMaterials[1].name}</label>
						<div class="flex gap-2">
							<input type="text" name="input2" bind:value={input2} class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]" />
							<button type="button" onclick={generateThermoseal} class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]" title="Generate test barcode">Test</button>
						</div>
						<label class="block text-sm text-[var(--color-tron-text)]">{data.config.inputMaterials[2].name}</label>
						<div class="flex gap-2">
							<input type="text" name="input3" bind:value={input3} class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]" />
							<button type="button" onclick={generateBarcode} class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-orange)] hover:text-[var(--color-tron-orange)]" title="Generate test barcode">Test</button>
						</div>
					</div>
					{#if form?.setInputLots && (form.setInputLots as { error?: string }).error}
						<p class="mt-1 text-sm text-[var(--color-tron-error)]">{(form.setInputLots as { error: string }).error}</p>
					{/if}
					<button type="submit" class="mt-3 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-white">Confirm inputs</button>
				</form>
			{:else if step === 'start'}
				<form method="POST" action="?/startBatch" use:enhance>
					<input type="hidden" name="lotId" value={lotId} />
					<p class="text-sm text-[var(--color-tron-text)]">All inputs set. Press Start to begin batch.</p>
					<button type="submit" class="mt-3 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-white">Start batch</button>
				</form>
			{:else if step === 'work'}
				<div class="space-y-4">
					{#if data.processSteps.length > 0}
						<div class="space-y-4">
							{#each data.processSteps as ps (ps.id)}
								<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4">
									<div class="flex items-center gap-2">
										<span class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-tron-cyan)] text-sm font-bold text-[var(--color-tron-bg-primary)]">
											{ps.stepNumber}
										</span>
										<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">{ps.title}</h3>
									</div>
									{#if ps.description}
										<p class="mt-2 text-sm text-[var(--color-tron-text-secondary)] whitespace-pre-wrap">{ps.description}</p>
									{/if}
									{#if ps.imageUrl}
										<img src={ps.imageUrl} alt="Step {ps.stepNumber}" class="mt-2 max-h-48 rounded border border-[var(--color-tron-border)]" />
									{/if}

									<!-- Operator entries for this step -->
									{#if entriesForStep(ps.id).length > 0}
										<div class="mt-3 space-y-2">
											<p class="text-xs font-medium text-[var(--color-tron-text-secondary)]">Operator Notes:</p>
											{#each entriesForStep(ps.id) as entry (entry.id)}
												<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-2">
													{#if entry.note}
														<p class="text-sm text-[var(--color-tron-text)]">"{entry.note}"</p>
													{/if}
													{#if entry.imageUrl}
														<img src={entry.imageUrl} alt="Operator photo" class="mt-1 max-h-32 rounded border border-[var(--color-tron-border)]" />
													{/if}
													<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
														{entry.operatorName} &mdash; {formatTime(entry.createdAt)}
													</p>
												</div>
											{/each}
										</div>
									{/if}

									<!-- Add note/photo form -->
									{#if activeNoteStep === ps.id}
										<form
											method="POST"
											action="?/addNote"
											enctype="multipart/form-data"
											use:enhance
											class="mt-3 space-y-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3"
										>
											<input type="hidden" name="lotId" value={lotId} />
											<input type="hidden" name="stepId" value={ps.id} />
											<textarea
												name="note"
												bind:value={noteText}
												rows="2"
												class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
												placeholder="Add a note..."
											></textarea>
											<input
												type="file"
												name="image"
												accept="image/*"
												class="block w-full text-xs text-[var(--color-tron-text-secondary)] file:mr-3 file:rounded file:border-0 file:bg-[var(--color-tron-cyan)] file:px-2 file:py-1 file:text-xs file:text-[var(--color-tron-bg-primary)]"
											/>
											{#if form?.addNote && (form.addNote as { error?: string }).error}
												<p class="text-xs text-[var(--color-tron-error)]">{(form.addNote as { error: string }).error}</p>
											{/if}
											<div class="flex gap-2">
												<button
													type="submit"
													class="rounded bg-[var(--color-tron-cyan)] px-3 py-1 text-xs font-medium text-[var(--color-tron-bg-primary)]"
												>
													Save
												</button>
												<button
													type="button"
													onclick={() => { activeNoteStep = null; noteText = ''; }}
													class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)]"
												>
													Cancel
												</button>
											</div>
										</form>
									{:else}
										<button
											type="button"
											onclick={() => { activeNoteStep = ps.id; noteText = ''; }}
											class="mt-2 text-xs text-[var(--color-tron-cyan)] hover:underline"
										>
											+ Add Note / Photo
										</button>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<p class="text-sm text-[var(--color-tron-text-secondary)]">Batch in progress.</p>
					{/if}

					<!-- Finish batch section -->
					<div class="rounded-lg border border-[var(--color-tron-cyan)] bg-[var(--color-tron-bg-primary)] p-4">
						<form method="POST" action="?/finishBatch" use:enhance class="flex items-end gap-3">
							<input type="hidden" name="lotId" value={lotId} />
							<div>
								<label class="block text-sm text-[var(--color-tron-text)]">Quantity (1&ndash;{data.config.maxBatchSize})</label>
								<input
									type="number"
									name="quantity"
									bind:value={quantity}
									min="1"
									max={data.config.maxBatchSize}
									class="mt-1 w-24 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-[var(--color-tron-text)]"
								/>
							</div>
							{#if form?.finishBatch && (form.finishBatch as { error?: string }).error}
								<p class="text-sm text-[var(--color-tron-error)]">{(form.finishBatch as { error: string }).error}</p>
							{/if}
							<button type="submit" class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-white">Finish Batch</button>
						</form>
					</div>
				</div>
			{/if}
		</div>

		<!-- Batch Notes & Photos (visible after QR binding) -->
		{#if lotId && step !== 'qr'}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<h2 class="text-sm font-medium text-[var(--color-tron-text)]">Batch Notes &amp; Photos</h2>
				<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
					Notes attached to lot {lotId}
				</p>

				{#if batchNotes.length > 0}
					<div class="mt-3 space-y-2">
						{#each batchNotes as note (note.id)}
							<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-2">
								{#if note.note}
									<p class="text-sm text-[var(--color-tron-text)]">"{note.note}"</p>
								{/if}
								{#if note.imageUrl}
									<img src={note.imageUrl} alt="Batch photo" class="mt-1 max-h-32 rounded border border-[var(--color-tron-border)]" />
								{/if}
								<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
									{note.operatorName} &mdash; {formatTime(note.createdAt)}
								</p>
							</div>
						{/each}
					</div>
				{/if}

				{#if showBatchNoteForm}
					<form
						method="POST"
						action="?/addBatchNote"
						enctype="multipart/form-data"
						use:enhance
						class="mt-3 space-y-2 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3"
					>
						<input type="hidden" name="lotId" value={lotId} />
						<textarea
							name="note"
							bind:value={batchNoteText}
							rows="2"
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text)]"
							placeholder="Add a batch note..."
						></textarea>
						<input
							type="file"
							name="image"
							accept="image/*"
							class="block w-full text-xs text-[var(--color-tron-text-secondary)] file:mr-3 file:rounded file:border-0 file:bg-[var(--color-tron-cyan)] file:px-2 file:py-1 file:text-xs file:text-[var(--color-tron-bg-primary)]"
						/>
						{#if form?.addBatchNote && (form.addBatchNote as { error?: string }).error}
							<p class="text-xs text-[var(--color-tron-error)]">{(form.addBatchNote as { error: string }).error}</p>
						{/if}
						<div class="flex gap-2">
							<button type="submit" class="rounded bg-[var(--color-tron-cyan)] px-3 py-1 text-xs font-medium text-[var(--color-tron-bg-primary)]">Save</button>
							<button type="button" onclick={() => { showBatchNoteForm = false; batchNoteText = ''; }} class="rounded border border-[var(--color-tron-border)] px-3 py-1 text-xs text-[var(--color-tron-text-secondary)]">Cancel</button>
						</div>
					</form>
				{:else}
					<button
						type="button"
						onclick={() => { showBatchNoteForm = true; batchNoteText = ''; }}
						class="mt-2 text-xs text-[var(--color-tron-cyan)] hover:underline"
					>
						+ Add Batch Note / Photo
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if handoffOpen && handoffPrompt}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			role="dialog"
			aria-modal="true"
		>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6 shadow-lg">
				<h3 class="text-lg font-semibold text-[var(--color-tron-text)]">Handoff</h3>
				<p class="mt-2 text-[var(--color-tron-text)]">{handoffPrompt}</p>
				<button
					type="button"
					onclick={() => {
						handoffOpen = false;
						step = 'qr';
						lotId = '';
						qrCodeRef = '';
						input1 = '';
						input2 = '';
						input3 = '';
						entries = [];
						batchNotes = [];
						showBatchNoteForm = false;
					}}
					class="mt-4 rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-white"
				>
					Acknowledge
				</button>
			</div>
		</div>
	{/if}
{/if}
