<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	let { data } = $props();

	// Phase is locked for forensic capture — these images are always post-run R&D.
	const PHASE = 'post_run';

	// Sticky cartridge context
	let cartridgeId = $state<string | null>(null);
	let cartridgeStatus = $state<string | null>(null);
	let cartridgePhotoCount = $state<number>(0);
	let scannedAt = $state<number | null>(null);

	// Forensic context — optional fields tying captures to a test run / session.
	// Stored on CvImage.metadata.forensic by the capture endpoint.
	let runId = $state('');
	let sessionId = $state('');
	let forensicNotes = $state('');

	// Scanner-wedge buffer
	let scanInput = $state('');
	let scanInputEl: HTMLInputElement | null = null;

	// Camera
	let videoEl = $state<HTMLVideoElement | null>(null);
	let stream = $state<MediaStream | null>(null);
	let cameras = $state<MediaDeviceInfo[]>([]);
	let selectedCameraId = $state<string | null>(null);
	let cameraError = $state<string | null>(null);

	// Status / messaging
	let banner = $state<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
	let bannerTimer: ReturnType<typeof setTimeout> | null = null;
	function flashBanner(kind: 'ok' | 'err' | 'info', text: string, ms = 3500) {
		if (bannerTimer) clearTimeout(bannerTimer);
		banner = { kind, text };
		bannerTimer = setTimeout(() => { banner = null; }, ms);
	}

	// Just-captured strip (newest first, max 10)
	type Capture = { id: string; cartridgeImageNumber: string; phase: string; capturedAt: number; url: string | null };
	let recentCaptures = $state<Capture[]>([]);

	// Submission lock so Space-spam doesn't fire multiple POSTs in flight
	let submitting = $state(false);

	let refocusInterval: ReturnType<typeof setInterval> | null = null;

	async function refreshCameras() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			cameras = devices.filter(d => d.kind === 'videoinput');
			if (!selectedCameraId && cameras.length > 0) selectedCameraId = cameras[0].deviceId;
		} catch (e) {
			cameraError = e instanceof Error ? e.message : String(e);
		}
	}

	async function startCamera() {
		if (stream) stopCamera();
		cameraError = null;
		try {
			const constraints: MediaStreamConstraints = {
				video: selectedCameraId
					? { deviceId: { exact: selectedCameraId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
					: { width: { ideal: 1920 }, height: { ideal: 1080 } },
				audio: false
			};
			stream = await navigator.mediaDevices.getUserMedia(constraints);
			if (videoEl) {
				videoEl.srcObject = stream;
				await videoEl.play();
			}
			await refreshCameras();
		} catch (e) {
			cameraError = e instanceof Error ? e.message : String(e);
			if (cameras.length > 1 && selectedCameraId) {
				const idx = cameras.findIndex(c => c.deviceId === selectedCameraId);
				const next = cameras[(idx + 1) % cameras.length];
				if (next && next.deviceId !== selectedCameraId) {
					selectedCameraId = next.deviceId;
					await startCamera();
				}
			}
		}
	}

	function stopCamera() {
		if (stream) {
			stream.getTracks().forEach(t => t.stop());
			stream = null;
		}
		if (videoEl) videoEl.srcObject = null;
	}

	async function handleScan(rawCode: string) {
		const code = rawCode.trim();
		if (!code) return;

		try {
			const res = await fetch(`/api/cv/lookup-cartridge?code=${encodeURIComponent(code)}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				flashBanner('err', body.error || `Cartridge ${code} not found in BIMS`);
				cartridgeId = null;
				cartridgeStatus = null;
				cartridgePhotoCount = 0;
				return;
			}
			const data = await res.json();
			cartridgeId = data.cartridgeRecordId;
			cartridgeStatus = data.status ?? null;
			cartridgePhotoCount = data.photoCount ?? 0;
			scannedAt = Date.now();
			flashBanner('ok', `Locked on ${cartridgeId} — ${cartridgePhotoCount} prior photos`);
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Lookup failed');
		}
	}

	async function capturePhoto() {
		if (submitting) return;
		if (!cartridgeId) {
			flashBanner('err', 'Scan a cartridge first');
			return;
		}
		if (!videoEl || !stream) {
			flashBanner('err', 'Camera not running');
			return;
		}

		submitting = true;
		try {
			const canvas = document.createElement('canvas');
			canvas.width = videoEl.videoWidth;
			canvas.height = videoEl.videoHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('canvas 2d context unavailable');
			ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

			const blob: Blob = await new Promise((resolve, reject) => {
				canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.92);
			});

			const form = new FormData();
			form.append('file', blob, `forensic.jpg`);
			form.append('cartridgeId', cartridgeId);
			form.append('phase', PHASE);
			// Only send forensic fields when the operator filled them in — endpoint
			// treats them as optional and stashes them under metadata.forensic.
			if (runId.trim()) form.append('runId', runId.trim());
			if (sessionId.trim()) form.append('sessionId', sessionId.trim());
			if (forensicNotes.trim()) form.append('forensicNotes', forensicNotes.trim());

			const res = await fetch('/api/cv/capture', { method: 'POST', body: form });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			const result = await res.json();

			const cap: Capture = {
				id: result.imageId,
				cartridgeImageNumber: result.cartridgeImageNumber,
				phase: result.phase,
				capturedAt: Date.now(),
				url: result.imageUrl
			};
			recentCaptures = [cap, ...recentCaptures].slice(0, 10);
			cartridgePhotoCount += 1;
			flashBanner('ok', `Captured ${result.cartridgeImageNumber}`, 1800);
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Capture failed');
		} finally {
			submitting = false;
			scanInputEl?.focus();
		}
	}

	function onScanKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			const code = scanInput;
			scanInput = '';
			handleScan(code);
		}
	}

	function onGlobalKeydown(e: KeyboardEvent) {
		// Space anywhere = capture (except in input fields)
		const target = e.target as HTMLElement;
		if (e.key === ' ' && target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT') {
			e.preventDefault();
			capturePhoto();
		}
	}

	function refocusScanner() {
		// Don't steal focus from form inputs, dropdowns, or buttons.
		if (scanInputEl && document.activeElement !== scanInputEl) {
			const active = document.activeElement as HTMLElement;
			if (
				active?.tagName === 'SELECT' ||
				active?.tagName === 'BUTTON' ||
				active?.tagName === 'INPUT' ||
				active?.tagName === 'TEXTAREA'
			) return;
			scanInputEl.focus();
		}
	}

	onMount(() => {
		(async () => {
			await refreshCameras();
			await startCamera();
			scanInputEl?.focus();
		})();
		refocusInterval = setInterval(refocusScanner, 500);
	});

	onDestroy(() => {
		stopCamera();
		if (bannerTimer) clearTimeout(bannerTimer);
		if (refocusInterval) clearInterval(refocusInterval);
	});
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<div class="min-h-screen bg-[var(--color-tron-bg-primary)] p-4 sm:p-6">
	<div class="mx-auto max-w-6xl space-y-4">
		<header class="flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Forensic Capture <span class="text-sm font-normal text-[var(--color-tron-text-secondary)]">(R&amp;D)</span></h1>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Post-run failure-analysis photography. Scan a cartridge, press Space to capture.
				</p>
			</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				Operator: <span class="text-[var(--color-tron-cyan)]">{data.user.username}</span>
			</div>
		</header>

		<!-- R&D mode banner — non-dismissable, distinguishes from manufacturing QC capture -->
		<div class="rounded border border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.08)] p-3 text-sm text-[var(--color-tron-yellow,#facc15)]">
			<strong>R&amp;D forensic capture.</strong> These images are for failure analysis, not manufacturing QC. Phase is locked to <code class="font-mono">post_run</code>.
			Tag with a <code class="font-mono">runId</code> or <code class="font-mono">sessionId</code> below if you want to tie photos to a specific test run.
		</div>

		<!-- Banner -->
		{#if banner}
			<div class="rounded border p-3 text-sm
				{banner.kind === 'ok' ? 'border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)] text-[var(--color-tron-green,#39ff14)]' : ''}
				{banner.kind === 'err' ? 'border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] text-[var(--color-tron-red,#ff3366)]' : ''}
				{banner.kind === 'info' ? 'border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.08)] text-[var(--color-tron-cyan)]' : ''}">
				{banner.text}
			</div>
		{/if}

		<!-- Context bar -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="flex flex-wrap items-center gap-4">
				<div class="flex-1 min-w-[200px]">
					<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Cartridge</div>
					{#if cartridgeId}
						<div class="font-mono text-lg text-[var(--color-tron-green,#39ff14)]">🟢 {cartridgeId}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">
							{cartridgeStatus ?? 'unknown'} · {cartridgePhotoCount} prior photo{cartridgePhotoCount === 1 ? '' : 's'}
						</div>
					{:else}
						<div class="font-mono text-lg text-[var(--color-tron-red,#ff3366)]">⚠ Scan to start</div>
					{/if}
				</div>
				<div>
					<div class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Phase</div>
					<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 font-mono text-sm text-[var(--color-tron-yellow,#facc15)]">{PHASE}</div>
				</div>
				<div>
					<label for="cam-sel" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Camera</label>
					<select id="cam-sel" bind:value={selectedCameraId} onchange={() => startCamera()} class="tron-input">
						{#each cameras as c (c.deviceId)}
							<option value={c.deviceId}>{c.label || `Camera ${c.deviceId.slice(0, 6)}`}</option>
						{/each}
					</select>
				</div>
			</div>

			<!-- Forensic context (optional) -->
			<div class="mt-3 grid gap-3 sm:grid-cols-3">
				<div>
					<label for="run-id" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Run ID <span class="text-[10px] text-[var(--color-tron-text-secondary)]">(optional)</span></label>
					<input id="run-id" bind:value={runId} type="text" autocomplete="off" placeholder="e.g. RUN-2026-05-18-001" class="tron-input w-full font-mono" />
				</div>
				<div>
					<label for="session-id" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Session ID <span class="text-[10px] text-[var(--color-tron-text-secondary)]">(optional)</span></label>
					<input id="session-id" bind:value={sessionId} type="text" autocomplete="off" placeholder="e.g. assay session id" class="tron-input w-full font-mono" />
				</div>
				<div>
					<label for="forensic-notes" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Notes <span class="text-[10px] text-[var(--color-tron-text-secondary)]">(optional)</span></label>
					<input id="forensic-notes" bind:value={forensicNotes} type="text" autocomplete="off" placeholder="failure symptom, angle, etc." class="tron-input w-full" />
				</div>
			</div>
		</div>

		<!-- Camera -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-black p-2">
			{#if cameraError}
				<div class="aspect-video flex items-center justify-center text-[var(--color-tron-red,#ff3366)]">
					{cameraError}
				</div>
			{:else}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} class="aspect-video w-full rounded" playsinline autoplay muted></video>
			{/if}
		</div>

		<!-- Action bar -->
		<div class="flex items-center justify-between gap-3">
			<button
				type="button"
				onclick={capturePhoto}
				disabled={submitting || !cartridgeId || !stream}
				class="rounded bg-[var(--color-tron-cyan)] px-6 py-3 text-lg font-bold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
			>
				{submitting ? 'Capturing…' : '📷 Capture (Space)'}
			</button>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				This session: {recentCaptures.length} photo{recentCaptures.length === 1 ? '' : 's'}
			</div>
		</div>

		<!-- Hidden scanner-wedge input — autofocused; refocuses every 500ms -->
		<input
			bind:this={scanInputEl}
			bind:value={scanInput}
			onkeydown={onScanKeydown}
			type="text"
			autocomplete="off"
			inputmode="none"
			class="sr-only"
			aria-hidden="true"
			tabindex="-1"
		/>

		<!-- Recent captures strip -->
		{#if recentCaptures.length > 0}
			<div>
				<h3 class="mb-2 text-sm font-semibold text-[var(--color-tron-text-secondary)] uppercase">Just captured</h3>
				<div class="flex gap-2 overflow-x-auto">
					{#each recentCaptures as cap (cap.id)}
						<div class="shrink-0 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-2 text-xs">
							{#if cap.url}
								<img src={cap.url} alt={cap.cartridgeImageNumber} class="h-32 w-32 rounded object-cover" />
							{/if}
							<div class="mt-1 font-mono text-[var(--color-tron-cyan)] truncate w-32">{cap.cartridgeImageNumber}</div>
							<div class="text-[var(--color-tron-text-secondary)] truncate w-32">{cap.phase}</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>
