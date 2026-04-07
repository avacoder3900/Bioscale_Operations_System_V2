<script lang="ts">
	import { CARTRIDGE_PHASES, IMAGE_TAG_LABELS } from '$lib/types/cv';
	import type { InspectionResponse, ImageResponse } from '$lib/types/cv';

	let { data } = $props();

	// Form state
	let selectedSampleId = $state('');
	let selectedCameraIndex = $state(0);
	let inspectionType = $state('anomaly_detection');
	let cartridgeId = $state('');
	let selectedPhase = $state('');
	let selectedLabels = $state<string[]>([]);
	let tagNotes = $state('');

	// Capture state
	let capturing = $state(false);
	let captureError = $state('');
	let capturedImage = $state<ImageResponse | null>(null);
	let activeInspection = $state<InspectionResponse | null>(null);
	let pollingActive = $state(false);
	let tagging = $state(false);
	let tagSuccess = $state(false);

	// Session history
	let sessionCaptures = $state<Array<{ image: ImageResponse; inspection: InspectionResponse }>>([]);

	async function handleCapture() {
		if (!selectedSampleId) {
			captureError = 'Please select a sample first.';
			return;
		}

		capturing = true;
		captureError = '';
		capturedImage = null;
		activeInspection = null;
		tagSuccess = false;

		try {
			const res = await fetch('/api/cv/capture', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sample_id: selectedSampleId,
					camera_index: selectedCameraIndex,
					inspection_type: inspectionType
				})
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: 'Capture failed' }));
				throw new Error(body.error || `HTTP ${res.status}`);
			}

			const result = await res.json();
			capturedImage = result.image;
			activeInspection = result.inspection;

			// Start polling
			startPolling(result.inspection.id);
		} catch (e) {
			captureError = e instanceof Error ? e.message : 'Capture failed';
		} finally {
			capturing = false;
		}
	}

	function startPolling(inspectionId: string) {
		pollingActive = true;
		let attempts = 0;
		const maxAttempts = 30;

		const interval = setInterval(async () => {
			attempts++;
			if (attempts >= maxAttempts) {
				clearInterval(interval);
				pollingActive = false;
				captureError = 'Inspection timed out. Check CV worker status.';
				return;
			}

			try {
				const res = await fetch(`/api/cv/inspections/${inspectionId}/poll`);
				if (!res.ok) return;

				const insp: InspectionResponse = await res.json();
				activeInspection = insp;

				if (insp.status === 'complete' || insp.status === 'failed') {
					clearInterval(interval);
					pollingActive = false;

					if (capturedImage) {
						sessionCaptures = [{ image: capturedImage, inspection: insp }, ...sessionCaptures];
					}
				}
			} catch {
				// ignore transient poll errors
			}
		}, 2000);
	}

	async function handleTag() {
		if (!capturedImage || !cartridgeId || !selectedPhase) return;
		tagging = true;

		try {
			const res = await fetch(`/api/cv/images/${capturedImage.id}/tags`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cartridge_record_id: cartridgeId,
					phase: selectedPhase,
					labels: selectedLabels,
					notes: tagNotes
				})
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: 'Tag failed' }));
				throw new Error(body.error);
			}

			tagSuccess = true;
		} catch (e) {
			captureError = e instanceof Error ? e.message : 'Failed to tag image';
		} finally {
			tagging = false;
		}
	}

	function toggleLabel(label: string) {
		if (selectedLabels.includes(label)) {
			selectedLabels = selectedLabels.filter((l) => l !== label);
		} else {
			selectedLabels = [...selectedLabels, label];
		}
	}

	function statusColor(status: string, result: string | null): string {
		if (status === 'pending') return 'bg-[var(--color-tron-yellow)] text-black';
		if (status === 'processing') return 'bg-blue-500 text-white animate-pulse';
		if (status === 'failed') return 'bg-gray-500 text-white';
		if (result === 'pass') return 'bg-[var(--color-tron-green)] text-black';
		if (result === 'fail') return 'bg-[var(--color-tron-red)] text-white';
		return 'bg-gray-500 text-white';
	}

	function statusLabel(status: string, result: string | null): string {
		if (status === 'pending') return 'Pending';
		if (status === 'processing') return 'Processing...';
		if (status === 'failed') return 'Error';
		if (result === 'pass') return 'PASS';
		if (result === 'fail') return 'FAIL';
		return status;
	}

	function severityColor(severity: string): string {
		if (severity === 'high') return 'text-[var(--color-tron-red)]';
		if (severity === 'medium') return 'text-[var(--color-tron-orange)]';
		return 'text-[var(--color-tron-yellow)]';
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Capture & Inspect</h1>
	</div>

	{#if data.error}
		<div class="rounded-lg border border-[var(--color-tron-yellow)] bg-[var(--color-tron-yellow)]/10 p-4">
			<p class="text-sm text-[var(--color-tron-yellow)]">{data.error}</p>
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- Left: Setup Panel -->
		<div class="space-y-4">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 space-y-4">
				<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Capture Setup</h2>

				<!-- Camera selector -->
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="camera-select">Camera</label>
					<select id="camera-select" bind:value={selectedCameraIndex} class="tron-input w-full px-3 py-2 text-sm">
						{#if data.cameras.length === 0}
							<option value={0}>Default Camera (0)</option>
						{:else}
							{#each data.cameras as cam (cam.index)}
								<option value={cam.index}>
									{cam.name} ({cam.width}x{cam.height}) {cam.is_open ? '' : '- offline'}
								</option>
							{/each}
						{/if}
					</select>
				</div>

				<!-- Sample selector -->
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="sample-select">Sample *</label>
					<select id="sample-select" bind:value={selectedSampleId} class="tron-input w-full px-3 py-2 text-sm">
						<option value="">Select a sample...</option>
						{#each data.samples as sample (sample.id)}
							<option value={sample.id}>{sample.name} {sample.project ? `(${sample.project})` : ''}</option>
						{/each}
					</select>
				</div>

				<!-- Inspection type -->
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="type-select">Inspection Type</label>
					<select id="type-select" bind:value={inspectionType} class="tron-input w-full px-3 py-2 text-sm">
						<option value="anomaly_detection">Anomaly Detection</option>
						<option value="visual">Visual</option>
					</select>
				</div>

				<!-- Cartridge ID (optional) -->
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="cartridge-input">Cartridge ID (optional)</label>
					<input
						id="cartridge-input"
						type="text"
						bind:value={cartridgeId}
						placeholder="e.g. CART-2026-0042"
						class="tron-input w-full px-3 py-2 text-sm"
					/>
				</div>

				<!-- Phase (optional) -->
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="phase-select">Phase (optional)</label>
					<select id="phase-select" bind:value={selectedPhase} class="tron-input w-full px-3 py-2 text-sm">
						<option value="">Select phase...</option>
						{#each CARTRIDGE_PHASES as phase}
							<option value={phase}>{phase.replace(/_/g, ' ')}</option>
						{/each}
					</select>
				</div>

				<!-- Capture button -->
				<button
					onclick={handleCapture}
					disabled={capturing || !selectedSampleId}
					class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 text-base font-bold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
				>
					{#if capturing}
						<span class="inline-flex items-center gap-2">
							<svg class="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
							</svg>
							Capturing...
						</span>
					{:else}
						Capture & Inspect
					{/if}
				</button>

				{#if captureError}
					<p class="text-sm text-[var(--color-tron-red)]">{captureError}</p>
				{/if}
			</div>
		</div>

		<!-- Right: Result Panel -->
		<div class="space-y-4">
			{#if activeInspection}
				<!-- Inspection Result -->
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 space-y-4">
					<!-- Status tracker -->
					<div class="space-y-2">
						<div class="flex items-center gap-2">
							<div class="h-2 w-2 rounded-full bg-[var(--color-tron-green)]"></div>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">Captured</span>
						</div>
						<div class="flex items-center gap-2">
							<div class="h-2 w-2 rounded-full {activeInspection.status === 'pending' ? 'bg-[var(--color-tron-yellow)] animate-pulse' : 'bg-[var(--color-tron-green)]'}"></div>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								{activeInspection.status === 'pending' ? 'Queued for inspection...' : 'Queued'}
							</span>
						</div>
						<div class="flex items-center gap-2">
							<div class="h-2 w-2 rounded-full {activeInspection.status === 'processing' ? 'bg-blue-500 animate-pulse' : activeInspection.status === 'complete' || activeInspection.status === 'failed' ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-border)]'}"></div>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								{activeInspection.status === 'processing' ? 'Analyzing...' : activeInspection.status === 'complete' || activeInspection.status === 'failed' ? 'Analysis done' : 'Waiting...'}
							</span>
						</div>
						<div class="flex items-center gap-2">
							<div class="h-2 w-2 rounded-full {activeInspection.status === 'complete' || activeInspection.status === 'failed' ? (activeInspection.result === 'pass' ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]') : 'bg-[var(--color-tron-border)]'}"></div>
							<span class="text-xs text-[var(--color-tron-text-secondary)]">
								{activeInspection.status === 'complete' ? 'Complete' : activeInspection.status === 'failed' ? 'Failed' : 'Pending result...'}
							</span>
						</div>
					</div>

					<!-- Result display -->
					{#if activeInspection.status === 'complete'}
						<div class="rounded-lg border-2 p-4 text-center {activeInspection.result === 'pass' ? 'border-[var(--color-tron-green)]' : 'border-[var(--color-tron-red)]'}">
							<span class="text-3xl font-black {activeInspection.result === 'pass' ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">
								{activeInspection.result === 'pass' ? 'PASS' : 'FAIL'}
							</span>
							{#if activeInspection.confidence_score !== null}
								<div class="mt-2">
									<div class="mx-auto h-2 w-48 rounded-full bg-[var(--color-tron-bg-tertiary)]">
										<div
											class="h-full rounded-full {activeInspection.result === 'pass' ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]'}"
											style="width: {Math.min(activeInspection.confidence_score * 100, 100)}%"
										></div>
									</div>
									<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
										Confidence: {(activeInspection.confidence_score * 100).toFixed(1)}%
									</p>
								</div>
							{/if}
							{#if activeInspection.processing_time_ms}
								<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
									{activeInspection.processing_time_ms}ms | {activeInspection.model_version}
								</p>
							{/if}
						</div>

						<!-- Defects -->
						{#if activeInspection.defects && activeInspection.defects.length > 0}
							<div class="space-y-1">
								<h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Defects</h3>
								{#each activeInspection.defects as defect}
									<div class="flex items-center gap-2 text-sm">
										<span class="{severityColor(defect.severity)} font-bold">
											{defect.severity === 'high' ? '!' : defect.severity === 'medium' ? '*' : '-'}
										</span>
										<span class="text-[var(--color-tron-text)]">{defect.type}</span>
										<span class="text-[var(--color-tron-text-secondary)]">- {defect.location}</span>
									</div>
								{/each}
							</div>
						{/if}
					{:else if activeInspection.status === 'failed'}
						<div class="rounded-lg border border-gray-500 p-4 text-center">
							<span class="text-lg font-bold text-gray-400">Inspection Error</span>
							<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
								The CV worker encountered an error. Check worker logs.
							</p>
						</div>
					{/if}
				</div>

				<!-- Captured image preview -->
				{#if capturedImage}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] overflow-hidden">
						<img
							src="{data.cvBaseUrl}/api/v1/images/{capturedImage.id}/file"
							alt="Captured"
							class="w-full"
						/>
					</div>
				{/if}

				<!-- Tagging (post-capture) -->
				{#if capturedImage && cartridgeId && selectedPhase && !tagSuccess}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 space-y-3">
						<h3 class="text-sm font-semibold text-[var(--color-tron-text)]">Tag Image</h3>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">
							Cartridge: {cartridgeId} | Phase: {selectedPhase}
						</p>

						<!-- Labels -->
						<div>
							<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]">Labels</label>
							<div class="flex flex-wrap gap-1.5">
								{#each IMAGE_TAG_LABELS as label}
									<button
										type="button"
										onclick={() => toggleLabel(label)}
										class="rounded px-2 py-0.5 text-xs transition-colors {selectedLabels.includes(label)
											? 'bg-[var(--color-tron-cyan)] text-black'
											: 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]'}"
									>
										{label.replace(/_/g, ' ')}
									</button>
								{/each}
							</div>
						</div>

						<!-- Notes -->
						<div>
							<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="tag-notes">Notes</label>
							<textarea
								id="tag-notes"
								bind:value={tagNotes}
								rows="2"
								class="tron-input w-full px-3 py-2 text-sm"
								placeholder="Optional notes..."
							></textarea>
						</div>

						<button
							onclick={handleTag}
							disabled={tagging}
							class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black transition-opacity disabled:opacity-50"
						>
							{tagging ? 'Saving...' : 'Save Tag'}
						</button>
					</div>
				{/if}

				{#if tagSuccess}
					<div class="rounded-lg border border-[var(--color-tron-green)] bg-[var(--color-tron-green)]/10 p-3">
						<p class="text-sm text-[var(--color-tron-green)]">Image tagged successfully.</p>
					</div>
				{/if}
			{:else}
				<!-- Empty state -->
				<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-20">
					<svg class="mb-4 h-16 w-16 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
						<path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
					</svg>
					<p class="text-sm text-[var(--color-tron-text-secondary)]">
						Select a sample and click "Capture & Inspect" to begin
					</p>
				</div>
			{/if}
		</div>
	</div>

	<!-- Session History -->
	{#if sessionCaptures.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
				<h2 class="text-sm font-semibold text-[var(--color-tron-text)]">Session Captures ({sessionCaptures.length})</h2>
			</div>
			<div class="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4">
				{#each sessionCaptures as cap (cap.inspection.id)}
					<div class="rounded border border-[var(--color-tron-border)] overflow-hidden">
						<img
							src="{data.cvBaseUrl}/api/v1/images/{cap.image.id}/thumbnail"
							alt="Capture"
							class="w-full aspect-video object-cover"
						/>
						<div class="p-2 flex items-center justify-between">
							<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold {statusColor(cap.inspection.status, cap.inspection.result)}">
								{statusLabel(cap.inspection.status, cap.inspection.result)}
							</span>
							{#if cap.inspection.confidence_score !== null}
								<span class="text-[10px] text-[var(--color-tron-text-secondary)]">
									{(cap.inspection.confidence_score * 100).toFixed(0)}%
								</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
