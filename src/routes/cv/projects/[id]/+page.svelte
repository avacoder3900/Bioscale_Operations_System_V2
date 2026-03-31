<script lang="ts">
	let { data } = $props();
	let activeTab = $state('import');
	const tabs = ['Import', 'Capture', 'Labels', 'Train', 'Test', 'Review', 'Integrate'];

	// Import tab
	let uploading = $state(false);
	let uploadMsg = $state('');
	let dragOver = $state(false);

	// Capture tab
	let videoEl = $state<HTMLVideoElement | null>(null);
	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let cameraStream = $state<MediaStream | null>(null);
	let cameraError = $state('');
	let cameraReady = $state(false);
	let capturedImage = $state<string | null>(null);
	let captureUploading = $state(false);
	let captureMsg = $state('');
	let captureCount = $state(0);
	let availableCameras = $state<MediaDeviceInfo[]>([]);
	let selectedCameraId = $state('');

	// Processing mode (matches LIZA: full = post-processed, raw = no processing)
	let processingMode = $state<'full' | 'raw'>(data.project.captureSettings?.mode || 'full');

	// QR scanning
	let detectedQR = $state<string | null>(null);
	let qrLookupResult = $state<any>(null);
	let qrScanning = $state(false);
	let qrScanTimer = $state<ReturnType<typeof setInterval> | null>(null);
	let qrScanCanvas: HTMLCanvasElement | null = null;

	async function startQRScanning() {
		if (qrScanTimer) return;
		qrScanCanvas = document.createElement('canvas');
		qrScanning = true;

		const hasBarcodeDetector = 'BarcodeDetector' in window;
		let detector: any = null;
		if (hasBarcodeDetector) {
			detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
		}

		qrScanTimer = setInterval(async () => {
			if (!videoEl || !cameraReady || capturedImage || !qrScanCanvas) return;
			try {
				let codes: any[] = [];
				if (detector) {
					codes = await detector.detect(videoEl);
				} else {
					// Fallback: grab frame to canvas and try via ImageData
					qrScanCanvas.width = videoEl.videoWidth;
					qrScanCanvas.height = videoEl.videoHeight;
					const ctx = qrScanCanvas.getContext('2d');
					if (!ctx) return;
					ctx.drawImage(videoEl, 0, 0);
					// Without jsQR, we can only use BarcodeDetector
					// If unavailable, QR scanning won't work in this browser
				}
				if (codes.length > 0) {
					const qrValue = codes[0].rawValue;
					if (qrValue !== detectedQR) {
						detectedQR = qrValue;
						lookupBarcode(qrValue);
					}
				}
			} catch { /* scan error, ignore */ }
		}, 500);
	}

	function stopQRScanning() {
		if (qrScanTimer) {
			clearInterval(qrScanTimer);
			qrScanTimer = null;
		}
		qrScanning = false;
	}

	async function lookupBarcode(code: string) {
		try {
			const res = await fetch(`/api/cv/lookup-barcode?code=${encodeURIComponent(code)}`);
			if (res.ok) {
				qrLookupResult = await res.json();
			} else {
				qrLookupResult = { raw: code, type: 'unknown' };
			}
		} catch {
			qrLookupResult = { raw: code, type: 'unknown' };
		}
	}

	// Keyboard shortcuts
	function handleKeydown(e: KeyboardEvent) {
		if (activeTab !== 'capture' || !cameraStream) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;

		if (e.code === 'Space') {
			e.preventDefault();
			if (capturedImage) {
				saveCapture();
			} else if (cameraReady) {
				capturePhoto();
			}
		} else if (e.code === 'Escape') {
			if (capturedImage) retakePhoto();
		} else if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
			if (!cameraStream) startCamera();
			else stopCamera();
		}
	}

	async function loadCameras() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			availableCameras = devices.filter(d => d.kind === 'videoinput');
			if (availableCameras.length > 0 && !selectedCameraId) {
				selectedCameraId = availableCameras[0].deviceId;
			}
		} catch { /* ignore */ }
	}

	async function startCamera() {
		cameraError = '';
		cameraReady = false;
		capturedImage = null;
		captureMsg = '';
		stopCamera();
		try {
			await loadCameras();
			// Try selected camera first, then fall back to others
			const camerasToTry = selectedCameraId
				? [selectedCameraId, ...availableCameras.filter(c => c.deviceId !== selectedCameraId).map(c => c.deviceId)]
				: availableCameras.map(c => c.deviceId);

			let lastErr: any = null;
			for (const deviceId of camerasToTry) {
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
					selectedCameraId = deviceId;
					cameraStream = stream;
					// Wait for Svelte to render the video element, retry until it appears
					for (let attempt = 0; attempt < 20; attempt++) {
						await new Promise(r => setTimeout(r, 100));
						if (videoEl) break;
					}
					if (videoEl) {
						videoEl.srcObject = stream;
						await videoEl.play().catch(() => {});
						cameraReady = true;
					}
					startQRScanning();
					return; // success
				} catch (err) {
					lastErr = err;
				}
			}
			throw lastErr || new Error('No cameras available');
		} catch (err: any) {
			cameraError = err.message || 'Could not access camera. Check browser permissions.';
		}
	}

	function stopCamera() {
		stopQRScanning();
		if (cameraStream) {
			cameraStream.getTracks().forEach(t => t.stop());
			cameraStream = null;
		}
		cameraReady = false;
		detectedQR = null;
		qrLookupResult = null;
	}

	function capturePhoto() {
		if (!videoEl || !canvasEl) return;
		canvasEl.width = videoEl.videoWidth;
		canvasEl.height = videoEl.videoHeight;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;
		ctx.drawImage(videoEl, 0, 0);
		capturedImage = canvasEl.toDataURL('image/jpeg', 0.92);
	}

	async function resumeLiveFeed() {
		capturedImage = null;
		// Re-attach stream to video element after Svelte re-renders it
		for (let attempt = 0; attempt < 20; attempt++) {
			await new Promise(r => setTimeout(r, 100));
			if (videoEl) break;
		}
		if (videoEl && cameraStream) {
			videoEl.srcObject = cameraStream;
			await videoEl.play().catch(() => {});
			cameraReady = true;
		}
	}

	function retakePhoto() {
		resumeLiveFeed();
	}

	async function saveCapture() {
		if (!capturedImage) return;
		captureUploading = true;
		captureMsg = '';
		try {
			const res = await fetch(capturedImage);
			const blob = await res.blob();
			const qrLabel = detectedQR ? detectedQR.replace(/[/\\:*?"<>|]/g, '_').slice(0, 60) : 'UNKNOWN';
			const filename = `cartridge_capture_${qrLabel}_${String(captureCount + 1).padStart(3, '0')}.jpg`;
			const file = new File([blob], filename, { type: 'image/jpeg' });

			// Upload directly without using uploadFiles (which reloads the page)
			const presignRes = await fetch('/api/cv/images/presign', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId: data.project._id, filename, contentType: 'image/jpeg' })
			});
			if (!presignRes.ok) throw new Error('Presign failed');
			const { uploadUrl, key, uploadSecret } = await presignRes.json();

			const putRes = await fetch(uploadUrl, {
				method: 'PUT',
				headers: { 'Content-Type': 'image/jpeg', 'X-Upload-Secret': uploadSecret || '' },
				body: file
			});
			if (!putRes.ok) throw new Error('R2 upload failed');

			const recordRes = await fetch('/api/cv/images/record', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId: data.project._id, key, filename, contentType: 'image/jpeg', fileSize: file.size })
			});
			if (!recordRes.ok) throw new Error('Record failed');
			const recordData = await recordRes.json();

			captureCount++;
			captureMsg = `Saved! (${captureCount} captured this session)`;
			await resumeLiveFeed();

			// Trigger server-side LIZA processing in background (non-blocking)
			if (processingMode === 'full' && recordData.data?._id) {
				fetch('/api/cv/process-image', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ imageId: recordData.data._id, mode: 'full' })
				}).then(() => {
					captureMsg = `Saved + processed! (${captureCount} this session)`;
				}).catch(() => { /* processing failed silently — raw image is still saved */ });
			}
		} catch (err: any) {
			captureMsg = `Save failed: ${err.message}`;
		}
		captureUploading = false;
	}

	// Clean up camera when leaving capture tab or page
	$effect(() => {
		if (activeTab !== 'capture') stopCamera();
	});

	// Keyboard shortcuts
	$effect(() => {
		if (typeof window === 'undefined') return;
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	// Labels tab
	let labeling = $state<string | null>(null);

	// Train tab
	let training = $state(false);
	let trainStatus = $state<any>(null);
	let trainPollTimer = $state<ReturnType<typeof setInterval> | null>(null);

	// Test tab
	let testFile = $state<File | null>(null);
	let testing = $state(false);
	let testResult = $state<any>(null);

	const statusColors: Record<string, string> = {
		untrained: 'var(--color-tron-text-secondary)',
		training: 'var(--color-tron-yellow)',
		trained: 'var(--color-tron-green)',
		failed: 'var(--color-tron-red)'
	};

	async function uploadFiles(files: FileList | File[]) {
		uploading = true;
		uploadMsg = '';
		let count = 0;
		let lastError = '';
		for (const file of files) {
			try {
				// Step 1: Get presigned URL
				const presignRes = await fetch('/api/cv/images/presign', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ projectId: data.project._id, filename: file.name, contentType: file.type || 'image/jpeg' })
				});
				if (!presignRes.ok) {
					const err = await presignRes.json().catch(() => ({}));
					lastError = err.error || `Presign failed (${presignRes.status})`;
					continue;
				}
				const { uploadUrl, key, uploadSecret } = await presignRes.json();

				// Step 2: Upload to R2 via Cloudflare Worker proxy
				const putRes = await fetch(uploadUrl, {
					method: 'PUT',
					headers: {
						'Content-Type': file.type || 'image/jpeg',
						'X-Upload-Secret': uploadSecret || ''
					},
					body: file
				});
				if (!putRes.ok) {
					const errText = await putRes.text().catch(() => '');
					lastError = `R2 upload failed (${putRes.status}): ${errText}`;
					continue;
				}

				// Step 3: Create DB record
				const recordRes = await fetch('/api/cv/images/record', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ projectId: data.project._id, key, filename: file.name, contentType: file.type || 'image/jpeg', fileSize: file.size })
				});
				if (recordRes.ok) {
					count++;
				} else {
					const err = await recordRes.json().catch(() => ({}));
					lastError = err.error || `Record failed (${recordRes.status})`;
				}
			} catch (e: any) {
				lastError = e.message || 'Network error';
				console.error('Upload exception:', e);
			}
		}
		uploadMsg = count > 0
			? `Uploaded ${count} image${count !== 1 ? 's' : ''}${lastError ? ` (${files.length - count} failed: ${lastError})` : ''}`
			: `Upload failed: ${lastError || 'Unknown error'}`;
		uploading = false;
		if (count > 0) setTimeout(() => location.reload(), 800);
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files.length) uploadFiles(e.dataTransfer.files);
	}

	function handleFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files?.length) uploadFiles(input.files);
	}

	async function toggleLabel(imageId: string, current: string | null, newLabel: string) {
		labeling = imageId;
		const label = current === newLabel ? null : newLabel;
		try {
			await fetch(`/api/cv/images/${imageId}/label`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ label })
			});
			const img = data.images.find((i: any) => i._id === imageId);
			if (img) img.label = label;
			data.images = [...data.images]; // trigger reactivity
		} catch { /* skip */ }
		labeling = null;
	}

	async function startTraining() {
		training = true;
		try {
			const res = await fetch('/api/cv/train', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId: data.project._id })
			});
			const json = await res.json();
			if (!res.ok) { trainStatus = { status: 'failed', message: json.error }; training = false; return; }
			trainStatus = { status: 'training', progress: 0, message: 'Training started...' };
			pollTraining();
		} catch (err: any) {
			trainStatus = { status: 'failed', message: err.message };
			training = false;
		}
	}

	function pollTraining() {
		trainPollTimer = setInterval(async () => {
			try {
				const res = await fetch(`/api/cv/train?projectId=${data.project._id}`);
				const json = await res.json();
				trainStatus = json.data;
				if (trainStatus.status === 'complete' || trainStatus.status === 'failed') {
					clearInterval(trainPollTimer!);
					trainPollTimer = null;
					training = false;
				}
			} catch { /* retry */ }
		}, 3000);
	}

	async function runTest() {
		if (!testFile) return;
		testing = true;
		testResult = null;
		// First upload the test image
		const fd = new FormData();
		fd.append('file', testFile);
		fd.append('projectId', data.project._id);
		try {
			const uploadRes = await fetch('/api/cv/images', { method: 'POST', body: fd });
			const uploadJson = await uploadRes.json();
			if (!uploadRes.ok) { testResult = { error: uploadJson.error }; testing = false; return; }

			// Run inference
			const inferRes = await fetch('/api/cv/infer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageId: uploadJson.data._id, projectId: data.project._id })
			});
			testResult = (await inferRes.json()).data || (await inferRes.json());
		} catch (err: any) {
			testResult = { error: err.message };
		}
		testing = false;
	}

	function fmtDate(d: string) {
		return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<a href="/cv" class="text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">&larr; All Projects</a>
			<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">{data.project.name}</h2>
			{#if data.project.description}
				<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">{data.project.description}</p>
			{/if}
		</div>
		<span
			class="rounded-full px-3 py-1 text-sm font-semibold"
			style="color: {statusColors[data.project.modelStatus]}; background: color-mix(in srgb, {statusColors[data.project.modelStatus]} 20%, transparent)"
		>
			{data.project.modelStatus?.toUpperCase()}
		</span>
	</div>

	<!-- Stats Bar -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-text-primary)]">{data.project.imageCount || 0}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Images</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-green)]">{data.labelStats.approved}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Approved</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-red)]">{data.labelStats.rejected}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Rejected</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-text-secondary)]">{data.labelStats.unlabeled}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Unlabeled</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3 text-center">
			<div class="text-xl font-bold text-[var(--color-tron-purple)]">{data.inspections.length}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Inspections</div>
		</div>
	</div>

	<!-- Tab Bar -->
	<div class="flex gap-1 overflow-x-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-1">
		{#each tabs as tab}
			<button
				class="whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors {activeTab === tab.toLowerCase() ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]'}"
				onclick={() => activeTab = tab.toLowerCase()}
			>
				{tab}
			</button>
		{/each}
	</div>

	<!-- Tab Content -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-6">

		<!-- IMPORT TAB -->
		{#if activeTab === 'import'}
			<div
				class="flex min-h-[200px] flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors {dragOver ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/5' : 'border-[var(--color-tron-border)]'}"
				role="button"
				tabindex="0"
				ondragover={(e) => { e.preventDefault(); dragOver = true; }}
				ondragleave={() => dragOver = false}
				ondrop={handleDrop}
			>
				<svg class="mb-3 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
				</svg>
				<p class="mb-2 text-[var(--color-tron-text-primary)]">Drag & drop images here</p>
				<p class="mb-4 text-sm text-[var(--color-tron-text-secondary)]">or click to browse</p>
				<label class="cursor-pointer rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:opacity-90">
					Browse Files
					<input type="file" accept="image/*" multiple class="hidden" onchange={handleFileInput} />
				</label>
			</div>
			{#if uploading}
				<p class="mt-3 text-center text-sm text-[var(--color-tron-yellow)]">Uploading...</p>
			{/if}
			{#if uploadMsg}
				<p class="mt-3 text-center text-sm text-[var(--color-tron-green)]">{uploadMsg}</p>
			{/if}

		<!-- CAPTURE TAB -->
		{:else if activeTab === 'capture'}
			<div class="space-y-4">
				{#if !cameraStream && !cameraError}
					<div class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-tron-border)] py-16">
						<svg class="mb-3 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
						</svg>
						<p class="mb-4 text-[var(--color-tron-text-secondary)]">Connect a camera to capture images directly</p>
						<button onclick={startCamera} class="rounded-lg bg-[var(--color-tron-cyan)] px-6 py-3 text-sm font-medium text-black hover:opacity-90">
							Start Camera
						</button>
						<p class="mt-3 text-xs text-[var(--color-tron-text-secondary)]">Shortcuts: <kbd class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5">Space</kbd> capture/save &middot; <kbd class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5">Esc</kbd> retake</p>
					</div>
				{/if}

				{#if cameraError}
					<div class="rounded border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">
						{cameraError}
					</div>
					<button onclick={startCamera} class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:opacity-90">
						Retry
					</button>
				{/if}

				{#if cameraStream}
					<div class="grid gap-4 lg:grid-cols-[1fr_300px]">
						<!-- Left: Camera feed -->
						<div class="space-y-3">
							<!-- Camera selector + Processing mode -->
							<div class="flex flex-wrap items-center gap-4">
								{#if availableCameras.length > 1}
									<div class="flex items-center gap-2">
										<label class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Camera</label>
										<select
											bind:value={selectedCameraId}
											onchange={startCamera}
											class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-tron-text-primary)]"
										>
											{#each availableCameras as cam, i}
												<option value={cam.deviceId}>{cam.label || `Camera ${i + 1}`}</option>
											{/each}
										</select>
									</div>
								{/if}
								<div class="flex items-center gap-2">
									<label class="text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Processing</label>
									<div class="flex rounded border border-[var(--color-tron-border)]">
										<button
											onclick={() => processingMode = 'full'}
											class="px-3 py-1 text-xs font-medium transition-colors {processingMode === 'full' ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]'}"
										>Full</button>
										<button
											onclick={() => processingMode = 'raw'}
											class="border-l border-[var(--color-tron-border)] px-3 py-1 text-xs font-medium transition-colors {processingMode === 'raw' ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]'}"
										>Raw</button>
									</div>
								</div>
							</div>

							<!-- Live feed / captured image -->
							<div class="relative overflow-hidden rounded-lg border-2 border-[var(--color-tron-border)] bg-black">
								{#if capturedImage}
									<img src={capturedImage} alt="Captured" class="w-full" />
								{:else}
									<!-- svelte-ignore element_invalid_self_closing_tag -->
									<video bind:this={videoEl} autoplay playsinline muted class="w-full" />
								{/if}
								<!-- QR status overlay (display only, like LIZA) -->
								{#if cameraReady && !capturedImage}
									<div class="absolute left-0 top-0 right-0 flex items-center justify-between p-2">
										{#if detectedQR}
											<span class="rounded bg-[var(--color-tron-green)]/80 px-2 py-1 text-xs font-bold text-black">QR: {detectedQR.slice(0, 50)}</span>
										{:else}
											<span class="rounded bg-[var(--color-tron-red)]/60 px-2 py-1 text-xs font-bold text-white">QR: NOT DETECTED</span>
										{/if}
									</div>
									<div class="absolute bottom-0 left-0 right-0 flex items-center justify-between p-2">
										<span class="rounded-full bg-[var(--color-tron-green)]/80 px-3 py-1 text-xs font-bold text-black">LIVE</span>
										{#if captureCount > 0}
											<span class="rounded-full bg-[var(--color-tron-cyan)]/80 px-3 py-1 text-xs font-bold text-black">{captureCount} captured</span>
										{/if}
									</div>
								{/if}
							</div>
							<canvas bind:this={canvasEl} class="hidden"></canvas>

							<!-- Controls -->
							<div class="flex items-center justify-center gap-3">
								{#if capturedImage}
									<button
										onclick={retakePhoto}
										class="rounded-lg border border-[var(--color-tron-border)] px-6 py-3 text-sm font-medium text-[var(--color-tron-text-primary)] hover:bg-[var(--color-tron-bg-tertiary)]"
									>
										Retake <kbd class="ml-1 rounded bg-[var(--color-tron-bg-tertiary)] px-1 text-xs">Esc</kbd>
									</button>
									<button
										onclick={saveCapture}
										disabled={captureUploading}
										class="rounded-lg bg-[var(--color-tron-green)] px-6 py-3 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
									>
										{captureUploading ? 'Saving...' : 'Save to Project'} <kbd class="ml-1 rounded bg-black/20 px-1 text-xs">Space</kbd>
									</button>
								{:else}
									<button
										onclick={capturePhoto}
										disabled={!cameraReady}
										class="rounded-full bg-[var(--color-tron-cyan)] p-4 text-black shadow-lg transition-transform hover:scale-105 disabled:opacity-50"
										title="Capture (Space)"
									>
										<svg class="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<circle cx="12" cy="12" r="10" stroke-width="2"/>
											<circle cx="12" cy="12" r="4" fill="currentColor"/>
										</svg>
									</button>
									<button
										onclick={stopCamera}
										class="rounded-lg border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)]"
									>
										Stop Camera
									</button>
								{/if}
							</div>

							{#if captureMsg}
								<p class="text-center text-sm text-[var(--color-tron-green)]">{captureMsg}</p>
							{/if}
						</div>

						<!-- Right: QR Info Panel -->
						<div class="space-y-3">
							<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4">
								<h4 class="mb-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">QR Code Scanner</h4>
								{#if detectedQR}
									<div class="space-y-2">
										<div class="rounded border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-2">
											<p class="text-xs text-[var(--color-tron-text-secondary)]">Detected</p>
											<p class="break-all font-mono text-sm text-[var(--color-tron-green)]">{detectedQR}</p>
										</div>
										{#if qrLookupResult}
											{#if qrLookupResult.type === 'cartridge'}
												<div class="space-y-1 text-sm">
													<p class="text-[var(--color-tron-text-primary)]">Cartridge: <span class="font-semibold text-[var(--color-tron-cyan)]">{qrLookupResult.barcode}</span></p>
													{#if qrLookupResult.phase}<p class="text-[var(--color-tron-text-secondary)]">Phase: {qrLookupResult.phase}</p>{/if}
													{#if qrLookupResult.lotNumber}<p class="text-[var(--color-tron-text-secondary)]">Lot: {qrLookupResult.lotNumber}</p>{/if}
												</div>
											{:else if qrLookupResult.type === 'lot'}
												<div class="space-y-1 text-sm">
													<p class="text-[var(--color-tron-text-primary)]">Lot: <span class="font-semibold text-[var(--color-tron-cyan)]">{qrLookupResult.lotNumber}</span></p>
													{#if qrLookupResult.status}<p class="text-[var(--color-tron-text-secondary)]">Status: {qrLookupResult.status}</p>{/if}
												</div>
											{:else if qrLookupResult.type === 'part'}
												<div class="space-y-1 text-sm">
													<p class="text-[var(--color-tron-text-primary)]">Part: <span class="font-semibold text-[var(--color-tron-cyan)]">{qrLookupResult.name}</span></p>
													{#if qrLookupResult.barcode}<p class="text-[var(--color-tron-text-secondary)]">Barcode: {qrLookupResult.barcode}</p>{/if}
												</div>
											{:else}
												<p class="text-xs text-[var(--color-tron-text-secondary)]">No matching record found in BIMS</p>
											{/if}
										{/if}
									</div>
								{:else}
									<p class="text-sm text-[var(--color-tron-text-secondary)]">Point camera at a QR code to auto-identify cartridge, lot, or part.</p>
								{/if}
							</div>

							<!-- Session stats -->
							<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4">
								<h4 class="mb-2 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Session</h4>
								<div class="grid grid-cols-2 gap-2 text-center">
									<div>
										<div class="text-xl font-bold text-[var(--color-tron-cyan)]">{captureCount}</div>
										<div class="text-xs text-[var(--color-tron-text-secondary)]">Captured</div>
									</div>
									<div>
										<div class="text-xl font-bold {detectedQR ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-text-secondary)]'}">{detectedQR ? 'YES' : 'NO'}</div>
										<div class="text-xs text-[var(--color-tron-text-secondary)]">QR Lock</div>
									</div>
								</div>
							</div>

							<!-- Keyboard shortcuts -->
							<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4">
								<h4 class="mb-2 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Shortcuts</h4>
								<div class="space-y-1 text-xs">
									<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Capture / Save</span><kbd class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[var(--color-tron-text-primary)]">Space</kbd></div>
									<div class="flex justify-between"><span class="text-[var(--color-tron-text-secondary)]">Retake</span><kbd class="rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[var(--color-tron-text-primary)]">Esc</kbd></div>
								</div>
							</div>
						</div>
					</div>
				{/if}
			</div>

		<!-- LABELS TAB -->
		{:else if activeTab === 'labels'}
			{#if data.images.length === 0}
				<p class="text-center text-[var(--color-tron-text-secondary)]">No images yet. Upload images in the Import tab.</p>
			{:else}
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
					{#each data.images as image (image._id)}
						<div class="group relative overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)]">
							<div class="aspect-square bg-[var(--color-tron-bg-tertiary)]">
								{#if image.imageUrl}
									<img src={image.imageUrl} alt={image.filename} class="h-full w-full object-cover" />
								{:else}
									<div class="flex h-full items-center justify-center text-xs text-[var(--color-tron-text-secondary)]">No preview</div>
								{/if}
							</div>
							<!-- Label badge -->
							{#if image.label}
								<span class="absolute left-2 top-2 rounded-full px-2 py-0.5 text-xs font-semibold {image.label === 'approved' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}">
									{image.label === 'approved' ? 'GOOD' : 'DEFECT'}
								</span>
							{/if}
							<!-- Label buttons -->
							<div class="flex border-t border-[var(--color-tron-border)]">
								<button
									class="flex-1 py-1.5 text-xs font-medium transition-colors {image.label === 'approved' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-green)]'}"
									disabled={labeling === image._id}
									onclick={() => toggleLabel(image._id, image.label, 'approved')}
								>&#10003; Good</button>
								<button
									class="flex-1 border-l border-[var(--color-tron-border)] py-1.5 text-xs font-medium transition-colors {image.label === 'rejected' ? 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]' : 'text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-red)]'}"
									disabled={labeling === image._id}
									onclick={() => toggleLabel(image._id, image.label, 'rejected')}
								>&#10007; Defect</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

		<!-- TRAIN TAB -->
		{:else if activeTab === 'train'}
			<div class="space-y-6">
				<div class="grid grid-cols-3 gap-4">
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4 text-center">
						<div class="text-2xl font-bold text-[var(--color-tron-green)]">{data.labelStats.approved}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">Good Images</div>
					</div>
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4 text-center">
						<div class="text-2xl font-bold text-[var(--color-tron-red)]">{data.labelStats.rejected}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">Defect Images</div>
					</div>
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4 text-center">
						<div class="text-2xl font-bold text-[var(--color-tron-text-secondary)]">{data.labelStats.unlabeled}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">Unlabeled</div>
					</div>
				</div>

				{#if trainStatus}
					<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-4">
						<div class="mb-2 flex items-center justify-between text-sm">
							<span class="text-[var(--color-tron-text-primary)]">Training Status</span>
							<span class="font-semibold" style="color: {trainStatus.status === 'complete' ? 'var(--color-tron-green)' : trainStatus.status === 'failed' ? 'var(--color-tron-red)' : 'var(--color-tron-yellow)'}">{trainStatus.status?.toUpperCase()}</span>
						</div>
						{#if trainStatus.progress !== undefined}
							<div class="mb-2 h-2 overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
								<div class="h-full rounded-full bg-gradient-to-r from-[var(--color-tron-cyan)] to-[var(--color-tron-green)] transition-all" style="width: {Math.round(trainStatus.progress * 100)}%"></div>
							</div>
						{/if}
						{#if trainStatus.message}
							<p class="text-xs text-[var(--color-tron-text-secondary)]">{trainStatus.message}</p>
						{/if}
					</div>
				{/if}

				<button
					class="w-full rounded-lg bg-[var(--color-tron-cyan)] px-4 py-3 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
					disabled={training || (data.labelStats.approved + data.labelStats.rejected) < 5}
					onclick={startTraining}
				>
					{#if training}Training in Progress...{:else}Start Training{/if}
				</button>
				{#if (data.labelStats.approved + data.labelStats.rejected) < 5}
					<p class="text-center text-xs text-[var(--color-tron-text-secondary)]">Need at least 5 labeled images to start training.</p>
				{/if}
			</div>

		<!-- TEST TAB -->
		{:else if activeTab === 'test'}
			<div class="space-y-4">
				{#if data.project.modelStatus !== 'trained'}
					<p class="text-center text-[var(--color-tron-text-secondary)]">Train a model first before running tests.</p>
				{:else}
					<div>
						<label class="mb-1 block text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Test Image</label>
						<input type="file" accept="image/*" class="w-full text-sm text-[var(--color-tron-text-primary)]" onchange={(e) => { const t = e.target as HTMLInputElement; testFile = t.files?.[0] || null; }} />
					</div>
					<button
						class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
						disabled={!testFile || testing}
						onclick={runTest}
					>
						{testing ? 'Running Inference...' : 'Run Test'}
					</button>

					{#if testResult}
						{#if testResult.error}
							<div class="rounded border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4 text-sm text-[var(--color-tron-red)]">{testResult.error}</div>
						{:else}
							<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-6 text-center">
								<div class="mb-2 text-4xl font-bold {testResult.result === 'pass' ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}">
									{testResult.result?.toUpperCase()}
								</div>
								<div class="text-sm text-[var(--color-tron-text-secondary)]">
									Confidence: <span class="font-semibold text-[var(--color-tron-text-primary)]">{Math.round((testResult.confidenceScore || 0) * 100)}%</span>
								</div>
								{#if testResult.processingTimeMs}
									<div class="text-xs text-[var(--color-tron-text-secondary)]">{Math.round(testResult.processingTimeMs)}ms</div>
								{/if}
							</div>
						{/if}
					{/if}
				{/if}
			</div>

		<!-- REVIEW TAB -->
		{:else if activeTab === 'review'}
			{#if data.inspections.length === 0}
				<p class="text-center text-[var(--color-tron-text-secondary)]">No inspections yet.</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)] text-left">
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Result</th>
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Confidence</th>
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Status</th>
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Phase</th>
								<th class="px-4 py-3 text-xs uppercase tracking-wider text-[var(--color-tron-text-secondary)]">Date</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-[var(--color-tron-border)]">
							{#each data.inspections as insp (insp._id)}
								<tr class="transition-colors hover:bg-[var(--color-tron-bg-tertiary)]">
									<td class="px-4 py-2">
										{#if insp.result}
											<span class="rounded-full px-2 py-0.5 text-xs font-semibold {insp.result === 'pass' ? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' : 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}">
												{insp.result.toUpperCase()}
											</span>
										{:else}
											<span class="text-xs text-[var(--color-tron-text-secondary)]">—</span>
										{/if}
									</td>
									<td class="px-4 py-2 text-sm text-[var(--color-tron-text-primary)]">{insp.confidenceScore ? Math.round(insp.confidenceScore * 100) + '%' : '—'}</td>
									<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{insp.status}</td>
									<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{insp.phase || '—'}</td>
									<td class="px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">{fmtDate(insp.createdAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

		<!-- INTEGRATE TAB -->
		{:else if activeTab === 'integrate'}
			<div class="space-y-4">
				<h3 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">API Endpoints</h3>
				<div class="space-y-2 text-sm">
					{#each [
						['GET', `/api/cv/projects/${data.project._id}`, 'Get project details'],
						['GET', `/api/cv/projects/${data.project._id}/images`, 'List project images'],
						['POST', '/api/cv/images', 'Upload image (multipart, projectId required)'],
						['PATCH', '/api/cv/images/:id/label', 'Set image label (approved/rejected)'],
						['POST', '/api/cv/train', 'Start training (projectId in body)'],
						['GET', `/api/cv/train?projectId=${data.project._id}`, 'Poll training status'],
						['POST', '/api/cv/infer', 'Run inference (imageId + projectId in body)']
					] as [method, path, desc]}
						<div class="flex items-start gap-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3">
							<span class="rounded bg-[var(--color-tron-cyan)]/20 px-2 py-0.5 text-xs font-bold text-[var(--color-tron-cyan)]">{method}</span>
							<div>
								<code class="text-xs text-[var(--color-tron-text-primary)]">{path}</code>
								<p class="text-xs text-[var(--color-tron-text-secondary)]">{desc}</p>
							</div>
						</div>
					{/each}
				</div>

				<h3 class="mt-6 text-lg font-semibold text-[var(--color-tron-text-primary)]">Manufacturing Gate Integration</h3>
				<p class="text-sm text-[var(--color-tron-text-secondary)]">
					To use this CV project as a manufacturing quality gate, call the inference endpoint at each production phase.
					Images with a "fail" result can automatically block the cartridge from proceeding to the next phase.
				</p>
				<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3">
					<p class="mb-1 text-xs text-[var(--color-tron-text-secondary)]">Project ID</p>
					<code class="text-sm text-[var(--color-tron-cyan)]">{data.project._id}</code>
				</div>
			</div>
		{/if}
	</div>
</div>
