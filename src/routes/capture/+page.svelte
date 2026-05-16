<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	let { data } = $props();

	// Sticky cartridge context
	let cartridgeId = $state<string | null>(null);
	let cartridgeStatus = $state<string | null>(null);
	let cartridgePhotoCount = $state<number>(0);
	let scannedAt = $state<number | null>(null);

	// Phase selection
	let phase = $state<string>('wax_filled');

	// Scanner-wedge buffer
	let scanInput = $state('');
	let scanInputEl: HTMLInputElement | null = null;

	// Camera
	let videoEl: HTMLVideoElement | null = null;
	let stream: MediaStream | null = null;
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
			// After permission granted, labels populate.
			await refreshCameras();
		} catch (e) {
			cameraError = e instanceof Error ? e.message : String(e);
			// Try the next camera if available
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

	function snapshotFrame(): Blob | null {
		if (!videoEl || !stream) return null;
		const canvas = document.createElement('canvas');
		canvas.width = videoEl.videoWidth;
		canvas.height = videoEl.videoHeight;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
		return null; // placeholder; we use toBlob below in capturePhoto
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
			form.append('file', blob, `capture.jpg`);
			form.append('cartridgeId', cartridgeId);
			form.append('phase', phase);

			const res = await fetch('/api/cv/capture', { method: 'POST', body: form });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			const result = await res.json();

			// Push to recent captures
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
			// Refocus the scanner input so the next scan still wedges correctly.
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
		// Keep scanner input always focused so wedge keystrokes land in it.
		if (scanInputEl && document.activeElement !== scanInputEl) {
			// Don't steal focus from the camera selector or phase dropdown.
			const active = document.activeElement as HTMLElement;
			if (active?.tagName === 'SELECT' || active?.tagName === 'BUTTON') return;
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
				<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Capture Station</h1>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Scan a cartridge with the USB scanner. Press Space to capture. Scan a new code to switch cartridge.
				</p>
			</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				Operator: <span class="text-[var(--color-tron-cyan)]">{data.user.username}</span>
			</div>
		</header>

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
					<label for="phase-sel" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Phase</label>
					<select id="phase-sel" bind:value={phase} class="tron-input">
						{#each data.phases as p (p)}
							<option value={p}>{p}</option>
						{/each}
					</select>
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
