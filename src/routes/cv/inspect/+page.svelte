<script lang="ts">
	import { CARTRIDGE_PHASES, IMAGE_TAG_LABELS } from '$lib/types/cv';
	import type { InspectionResponse, ImageResponse, CaptureAndInspectResponse } from '$lib/types/cv';

	let { data } = $props();

	let selectedSampleId = $state('');
	let selectedCameraIndex = $state(0);
	let inspectionType = $state('anomaly_detection');
	let cartridgeId = $state('');
	let phase = $state('');
	let tagLabels = $state<string[]>([]);
	let tagNotes = $state('');

	let capturing = $state(false);
	let captureError = $state('');
	let currentResult = $state<{ image: ImageResponse; inspection: InspectionResponse } | null>(null);
	let polling = $state(false);
	let sessionCaptures = $state<Array<{ image: ImageResponse; inspection: InspectionResponse }>>([]);

	// Webcam state
	let videoEl: HTMLVideoElement | undefined = $state();
	let streamActive = $state(false);

	async function startWebcam() {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				video: { width: { ideal: 1280 }, height: { ideal: 720 } }
			});
			if (videoEl) {
				videoEl.srcObject = stream;
				streamActive = true;
			}
		} catch (err) {
			captureError = 'Could not access camera. Please allow camera permissions.';
		}
	}

	function stopWebcam() {
		if (videoEl?.srcObject) {
			const stream = videoEl.srcObject as MediaStream;
			stream.getTracks().forEach((t) => t.stop());
			videoEl.srcObject = null;
			streamActive = false;
		}
	}

	async function captureAndInspect() {
		if (!selectedSampleId) {
			captureError = 'Please select a sample first.';
			return;
		}

		capturing = true;
		captureError = '';
		currentResult = null;

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
				const err = await res.json().catch(() => ({ error: 'Capture failed' }));
				captureError = err.error || `Capture failed (${res.status})`;
				capturing = false;
				return;
			}

			const result: CaptureAndInspectResponse = await res.json();
			currentResult = { image: result.image, inspection: result.inspection };
			capturing = false;

			// Start polling if inspection is pending
			if (result.inspection.status === 'pending' || result.inspection.status === 'processing') {
				pollInspection(result.inspection.id);
			}
		} catch (err) {
			captureError = err instanceof Error ? err.message : 'Capture failed';
			capturing = false;
		}
	}

	async function pollInspection(inspectionId: string) {
		polling = true;
		for (let i = 0; i < 30; i++) {
			try {
				const res = await fetch(`/api/cv/inspections/${inspectionId}/poll`);
				if (!res.ok) break;
				const insp: InspectionResponse = await res.json();
				if (currentResult) {
					currentResult = { ...currentResult, inspection: insp };
				}
				if (insp.status === 'complete' || insp.status === 'failed') {
					if (currentResult) {
						sessionCaptures = [currentResult, ...sessionCaptures];
					}
					polling = false;
					return;
				}
			} catch { break; }
			await new Promise((r) => setTimeout(r, 2000));
		}
		polling = false;
	}

	async function tagImage() {
		if (!currentResult || !cartridgeId) return;
		try {
			await fetch(`/api/cv/images/${currentResult.image.id}/tags`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cartridge_record_id: cartridgeId,
					phase,
					labels: tagLabels,
					notes: tagNotes
				})
			});
		} catch { /* tag failed silently */ }
	}

	function toggleLabel(label: string) {
		if (tagLabels.includes(label)) {
			tagLabels = tagLabels.filter((l) => l !== label);
		} else {
			tagLabels = [...tagLabels, label];
		}
	}
</script>

<div class="space-y-6">
	<h2 class="tron-heading text-2xl font-bold text-[var(--color-tron-cyan)]">
		Capture & Inspect
	</h2>

	<div class="grid gap-6 lg:grid-cols-2">
		<!-- Left: Webcam + Setup -->
		<div class="space-y-4">
			<!-- Live Preview -->
			<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-black">
				<!-- svelte-ignore element_invalid_self_closing_tag -->
				<video
					bind:this={videoEl}
					autoplay
					playsinline
					muted
					class="aspect-video w-full {streamActive ? '' : 'hidden'}"
				/>
				{#if !streamActive}
					<div class="flex aspect-video items-center justify-center">
						<button
							onclick={startWebcam}
							class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 font-medium text-[var(--color-tron-bg-primary)] transition-colors hover:opacity-90"
						>
							Start Camera Preview
						</button>
					</div>
				{/if}
			</div>

			<!-- Setup Form -->
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="space-y-3">
					<!-- Sample Selector -->
					<div>
						<label for="sample" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Sample *</label>
						<select
							id="sample"
							bind:value={selectedSampleId}
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
						>
							<option value="">Select a sample...</option>
							{#each data.samples as sample}
								<option value={sample.id}>{sample.name}{sample.project ? ` (${sample.project})` : ''}</option>
							{/each}
						</select>
					</div>

					<!-- Camera Selector -->
					<div>
						<label for="camera" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">CV API Camera</label>
						<select
							id="camera"
							bind:value={selectedCameraIndex}
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
						>
							{#each data.cameras as cam}
								<option value={cam.index}>{cam.name} ({cam.width}x{cam.height}) {cam.is_open ? '' : '- OFFLINE'}</option>
							{/each}
							{#if data.cameras.length === 0}
								<option value={0}>Camera 0 (default)</option>
							{/if}
						</select>
					</div>

					<!-- Inspection Type -->
					<div>
						<label for="inspType" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Inspection Type</label>
						<select
							id="inspType"
							bind:value={inspectionType}
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
						>
							<option value="anomaly_detection">Anomaly Detection</option>
							<option value="visual">Visual Inspection</option>
						</select>
					</div>

					<!-- Cartridge ID (optional) -->
					<div>
						<label for="cartId" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Cartridge ID (optional)</label>
						<input
							id="cartId"
							type="text"
							bind:value={cartridgeId}
							placeholder="e.g. CART-2026-0042"
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
						/>
					</div>

					<!-- Phase (optional) -->
					<div>
						<label for="phase" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Phase (optional)</label>
						<select
							id="phase"
							bind:value={phase}
							class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
						>
							<option value="">Select phase...</option>
							{#each CARTRIDGE_PHASES as p}
								<option value={p}>{p.replace(/_/g, ' ')}</option>
							{/each}
						</select>
					</div>

					<!-- Capture Button -->
					<button
						onclick={captureAndInspect}
						disabled={capturing || !selectedSampleId}
						class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-4 py-3 text-lg font-bold text-[var(--color-tron-bg-primary)] transition-colors hover:opacity-90 disabled:opacity-50"
					>
						{capturing ? 'Capturing...' : 'Capture & Inspect'}
					</button>

					{#if captureError}
						<p class="text-sm text-[var(--color-tron-red)]">{captureError}</p>
					{/if}
				</div>
			</div>
		</div>

		<!-- Right: Result -->
		<div class="space-y-4">
			{#if currentResult}
				<!-- Captured Image -->
				<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)]">
					<img
						src={currentResult.image.image_url || `/api/cv/images/${currentResult.image.id}/file`}
						alt="Captured"
						class="aspect-video w-full object-contain bg-black"
					/>
				</div>

				<!-- Inspection Status Tracker -->
				<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
					<h3 class="mb-3 font-semibold text-[var(--color-tron-text-primary)]">Inspection Status</h3>
					<div class="space-y-2">
						<div class="flex items-center gap-2">
							<span class="text-[var(--color-tron-green)]">&#10003;</span>
							<span class="text-sm text-[var(--color-tron-text-primary)]">Image captured</span>
						</div>
						{#if currentResult.inspection.status === 'pending'}
							<div class="flex items-center gap-2">
								<span class="animate-pulse text-[var(--color-tron-yellow)]">&#9679;</span>
								<span class="text-sm text-[var(--color-tron-yellow)]">Inspection pending...</span>
							</div>
						{:else if currentResult.inspection.status === 'processing'}
							<div class="flex items-center gap-2">
								<span class="animate-pulse text-[var(--color-tron-cyan)]">&#9679;</span>
								<span class="text-sm text-[var(--color-tron-cyan)]">Processing...</span>
							</div>
						{:else if currentResult.inspection.status === 'complete'}
							<div class="flex items-center gap-2">
								<span class="text-[var(--color-tron-green)]">&#10003;</span>
								<span class="text-sm text-[var(--color-tron-green)]">Complete</span>
							</div>
						{:else}
							<div class="flex items-center gap-2">
								<span class="text-[var(--color-tron-red)]">&#10007;</span>
								<span class="text-sm text-[var(--color-tron-red)]">Inspection failed</span>
							</div>
						{/if}
					</div>
				</div>

				<!-- Result Card (when complete) -->
				{#if currentResult.inspection.status === 'complete'}
					<div class="rounded-lg border-2 {currentResult.inspection.result === 'pass' ? 'border-[var(--color-tron-green)]' : 'border-[var(--color-tron-red)]'} bg-[var(--color-tron-bg-secondary)] p-4">
						<div class="flex items-center justify-between">
							<span class="text-3xl font-bold {currentResult.inspection.result === 'pass' ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">
								{currentResult.inspection.result === 'pass' ? 'PASS' : 'FAIL'}
							</span>
							{#if currentResult.inspection.confidence_score !== null}
								<div class="text-right">
									<p class="text-xs text-[var(--color-tron-text-secondary)]">Confidence</p>
									<p class="text-lg font-semibold text-[var(--color-tron-text-primary)]">
										{(currentResult.inspection.confidence_score * 100).toFixed(1)}%
									</p>
								</div>
							{/if}
						</div>

						{#if currentResult.inspection.defects.length > 0}
							<div class="mt-3 space-y-1">
								<p class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Defects</p>
								{#each currentResult.inspection.defects as defect}
									<div class="flex items-center gap-2 text-sm">
										<span class="{defect.severity === 'high' ? 'text-[var(--color-tron-red)]' : defect.severity === 'medium' ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-text-secondary)]'}">&#9679;</span>
										<span class="text-[var(--color-tron-text-primary)]">{defect.type}</span>
										<span class="text-[var(--color-tron-text-secondary)]">&mdash; {defect.location}</span>
									</div>
								{/each}
							</div>
						{/if}

						{#if currentResult.inspection.processing_time_ms}
							<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
								{currentResult.inspection.processing_time_ms}ms &middot; {currentResult.inspection.model_version}
							</p>
						{/if}
					</div>
				{/if}

				<!-- Post-Capture Tagging -->
				{#if currentResult.inspection.status === 'complete' || currentResult.inspection.status === 'failed'}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
						<h3 class="mb-3 font-semibold text-[var(--color-tron-text-primary)]">Tag Image</h3>
						<div class="space-y-3">
							<!-- Labels -->
							<div>
								<p class="mb-1 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Labels</p>
								<div class="flex flex-wrap gap-1">
									{#each IMAGE_TAG_LABELS as label}
										<button
											onclick={() => toggleLabel(label)}
											class="rounded-full px-2.5 py-0.5 text-xs transition-colors
												{tagLabels.includes(label)
													? 'bg-[var(--color-tron-cyan)] text-[var(--color-tron-bg-primary)]'
													: 'border border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]'}"
										>
											{label.replace(/_/g, ' ')}
										</button>
									{/each}
								</div>
							</div>

							<!-- Notes -->
							<div>
								<label for="notes" class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Notes</label>
								<textarea
									id="notes"
									bind:value={tagNotes}
									rows="2"
									class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
								></textarea>
							</div>

							<button
								onclick={tagImage}
								disabled={!cartridgeId}
								class="rounded-lg border border-[var(--color-tron-cyan)] px-4 py-2 text-sm text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-50"
							>
								Save Tag
							</button>
						</div>
					</div>
				{/if}
			{:else if !capturing}
				<div class="flex aspect-video items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
					<p class="text-[var(--color-tron-text-secondary)]">Capture result will appear here</p>
				</div>
			{/if}
		</div>
	</div>

	<!-- Session History -->
	{#if sessionCaptures.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="border-b border-[var(--color-tron-border)] px-4 py-3">
				<h3 class="font-semibold text-[var(--color-tron-text-primary)]">Session Captures ({sessionCaptures.length})</h3>
			</div>
			<div class="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
				{#each sessionCaptures as cap}
					<div class="overflow-hidden rounded border border-[var(--color-tron-border)]">
						<img
							src={cap.image.image_url || `/api/cv/images/${cap.image.id}/file`}
							alt="Session capture"
							class="aspect-video w-full object-cover"
						/>
						<div class="px-2 py-1">
							{#if cap.inspection.result === 'pass'}
								<span class="text-xs font-semibold text-[var(--color-tron-green)]">PASS</span>
							{:else if cap.inspection.result === 'fail'}
								<span class="text-xs font-semibold text-[var(--color-tron-red)]">FAIL</span>
							{:else}
								<span class="text-xs text-[var(--color-tron-text-secondary)]">{cap.inspection.status}</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
