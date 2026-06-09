<script lang="ts">
	import { onDestroy } from 'svelte';

	interface Props {
		cartridgeId: string;
		phase: string;
		label?: string;
		disabled?: boolean;
		size?: 'sm' | 'md';
	}

	let { cartridgeId, phase, label = '📷 Take Photo', disabled = false, size = 'md' }: Props = $props();

	let open = $state(false);
	let videoEl: HTMLVideoElement | null = null;
	let stream: MediaStream | null = null;
	let cameras = $state<MediaDeviceInfo[]>([]);
	let selectedCameraId = $state<string | null>(null);
	let cameraError = $state<string | null>(null);
	let submitting = $state(false);
	let banner = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	let lastCapture = $state<{ cartridgeImageNumber: string; url: string | null } | null>(null);

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
		}
	}

	function stopCamera() {
		if (stream) {
			stream.getTracks().forEach(t => t.stop());
			stream = null;
		}
		if (videoEl) videoEl.srcObject = null;
	}

	async function openModal() {
		if (disabled || !cartridgeId) return;
		open = true;
		banner = null;
		lastCapture = null;
		await refreshCameras();
		await startCamera();
	}

	function closeModal() {
		stopCamera();
		open = false;
	}

	async function takePhoto() {
		if (submitting || !cartridgeId || !videoEl || !stream) return;
		submitting = true;
		try {
			const canvas = document.createElement('canvas');
			canvas.width = videoEl.videoWidth;
			canvas.height = videoEl.videoHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('canvas 2d unavailable');
			ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

			const blob: Blob = await new Promise((resolve, reject) => {
				canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.92);
			});

			const form = new FormData();
			form.append('file', blob, 'capture.jpg');
			form.append('cartridgeId', cartridgeId);
			form.append('phase', phase);

			const res = await fetch('/api/cv/capture', { method: 'POST', body: form });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			const result = await res.json();
			lastCapture = { cartridgeImageNumber: result.cartridgeImageNumber, url: result.imageUrl };
			banner = { kind: 'ok', text: `Captured ${result.cartridgeImageNumber}` };
		} catch (e) {
			banner = { kind: 'err', text: e instanceof Error ? e.message : 'Capture failed' };
		} finally {
			submitting = false;
		}
	}

	onDestroy(() => stopCamera());
</script>

<button
	type="button"
	onclick={openModal}
	disabled={disabled || !cartridgeId}
	class="rounded bg-[var(--color-tron-cyan)] font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40
		{size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'}"
	title={cartridgeId ? `Capture photo of ${cartridgeId} at ${phase}` : 'No cartridge selected'}
>
	{label}
</button>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onclick={closeModal}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="w-full max-w-3xl rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4" onclick={(e) => e.stopPropagation()}>
			<div class="mb-3 flex items-center justify-between">
				<div>
					<h3 class="text-lg font-bold text-[var(--color-tron-cyan)]">Capture photo</h3>
					<p class="text-xs text-[var(--color-tron-text-secondary)]">
						<span class="font-mono">{cartridgeId}</span> · phase: {phase}
					</p>
				</div>
				<button type="button" onclick={closeModal} class="rounded px-2 py-1 text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-tertiary)]">✕</button>
			</div>

			{#if banner}
				<div class="mb-3 rounded border p-2 text-sm
					{banner.kind === 'ok' ? 'border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)] text-[var(--color-tron-green,#39ff14)]' : 'border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] text-[var(--color-tron-red,#ff3366)]'}">
					{banner.text}
				</div>
			{/if}

			{#if cameras.length > 1}
				<div class="mb-2">
					<label for="cap-cam" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Camera</label>
					<select id="cap-cam" bind:value={selectedCameraId} onchange={() => startCamera()} class="tron-input w-full">
						{#each cameras as c (c.deviceId)}
							<option value={c.deviceId}>{c.label || `Camera ${c.deviceId.slice(0, 6)}`}</option>
						{/each}
					</select>
				</div>
			{/if}

			<div class="rounded border border-[var(--color-tron-border)] bg-black p-1">
				{#if cameraError}
					<div class="aspect-video flex items-center justify-center text-[var(--color-tron-red,#ff3366)]">{cameraError}</div>
				{:else}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video bind:this={videoEl} class="aspect-video w-full rounded" playsinline autoplay muted></video>
				{/if}
			</div>

			<div class="mt-3 flex items-center justify-between gap-2">
				<button type="button" onclick={closeModal} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)]">
					Done
				</button>
				<button
					type="button"
					onclick={takePhoto}
					disabled={submitting || !stream}
					class="rounded bg-[var(--color-tron-cyan)] px-6 py-2 text-sm font-bold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
				>
					{submitting ? 'Capturing…' : '📷 Capture'}
				</button>
			</div>

			{#if lastCapture}
				<div class="mt-3 flex items-center gap-2 rounded border border-[var(--color-tron-border)] p-2">
					{#if lastCapture.url}
						<img src={lastCapture.url} alt={lastCapture.cartridgeImageNumber} class="h-16 w-16 rounded object-cover" />
					{/if}
					<div class="text-xs">
						<div class="font-mono text-[var(--color-tron-cyan)]">{lastCapture.cartridgeImageNumber}</div>
						<div class="text-[var(--color-tron-text-secondary)]">just captured · take another with Capture above</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
