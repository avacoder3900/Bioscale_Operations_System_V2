<script lang="ts">
	// Portrait picker for a badge (BADGE-SYSTEM_PLAN.md §17.6). Crops the chosen
	// image to 4:5 around the centre and shrinks it to 480×600 JPEG in the
	// browser, so a 5 MB phone photo reaches the server as ~50 KB. The owning
	// form's enhance() puts `blob` into the FormData as `photo`; setting `blob`
	// back to null from outside clears the preview and the file input.
	import { onDestroy } from 'svelte';

	interface Props {
		blob?: Blob | null;
		/** The photo already on the badge, shown dimmed until a new one is picked. */
		currentUrl?: string | null;
		disabled?: boolean;
		id?: string;
	}
	let { blob = $bindable(null), currentUrl = null, disabled = false, id = 'badge-photo' }: Props = $props();

	const TARGET_W = 480;
	const TARGET_H = 600;

	let input: HTMLInputElement | undefined = $state();
	let previewUrl = $state<string | null>(null);
	let working = $state(false);
	let err = $state('');

	function setPreview(b: Blob | null) {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = b ? URL.createObjectURL(b) : null;
	}

	async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
		// createImageBitmap honours EXIF orientation, so a portrait phone shot stays upright.
		if (typeof createImageBitmap === 'function') {
			try {
				return await createImageBitmap(file, { imageOrientation: 'from-image' });
			} catch {
				/* fall through to <img> */
			}
		}
		return new Promise((resolve, reject) => {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
			img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
			img.src = url;
		});
	}

	async function shrink(file: File): Promise<Blob> {
		const img = await decode(file);
		const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
		const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
		if (!w || !h) throw new Error('Could not read that image.');
		// Centre crop to 4:5, then scale to the target size.
		const ratio = TARGET_W / TARGET_H;
		let sw = w, sh = h;
		if (w / h > ratio) sw = Math.round(h * ratio); else sh = Math.round(w / ratio);
		const sx = Math.round((w - sw) / 2);
		const sy = Math.round((h - sh) / 2);
		const canvas = document.createElement('canvas');
		canvas.width = TARGET_W;
		canvas.height = TARGET_H;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas is unavailable in this browser.');
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(img, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);
		if (!(img instanceof HTMLImageElement)) img.close();
		return new Promise((resolve, reject) =>
			canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the photo.'))), 'image/jpeg', 0.85)
		);
	}

	async function onPick(e: Event) {
		err = '';
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		working = true;
		try {
			const b = await shrink(file);
			setPreview(b);
			blob = b;
		} catch (ex) {
			err = ex instanceof Error ? ex.message : String(ex);
			blob = null;
			setPreview(null);
			if (input) input.value = '';
		} finally {
			working = false;
		}
	}

	// The parent resets by setting blob = null (after a successful save).
	$effect(() => {
		if (blob === null && previewUrl) {
			setPreview(null);
			if (input) input.value = '';
		}
	});
	onDestroy(() => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
</script>

<div class="flex items-center gap-3">
	<div class="h-[60px] w-[48px] shrink-0 overflow-hidden rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)]">
		{#if previewUrl}
			<img src={previewUrl} alt="New portrait" class="h-full w-full object-cover" />
		{:else if currentUrl}
			<img src={currentUrl} alt="Current portrait" class="h-full w-full object-cover opacity-60" />
		{:else}
			<div class="flex h-full w-full items-center justify-center text-center text-[9px] leading-tight text-[var(--color-tron-text-secondary)]">no photo</div>
		{/if}
	</div>
	<div class="min-w-0 flex-1">
		<input {id} type="file" name="photo" accept="image/*" {disabled} bind:this={input} onchange={onPick}
			class="block w-full text-xs text-[var(--color-tron-text-secondary)] file:mr-2 file:rounded file:border file:border-[var(--color-tron-border)] file:bg-transparent file:px-2 file:py-1 file:text-xs file:text-[var(--color-tron-text)] disabled:opacity-40" />
		<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">
			{#if working}Shrinking…
			{:else if err}<span class="text-[var(--color-tron-error)]">{err}</span>
			{:else}Cropped to 4:5 and shrunk to 480 × 600 in the browser before upload.{/if}
		</p>
	</div>
</div>
