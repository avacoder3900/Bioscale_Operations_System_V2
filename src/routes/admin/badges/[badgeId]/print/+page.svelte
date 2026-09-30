<script lang="ts">
	import { onMount } from 'svelte';
	import bwipjs from 'bwip-js/browser';

	interface Props {
		data: { badge: { badgeId: string; code: string; displayName: string; username: string | null; status: 'active' | 'revoked'; issuedAt: string | null } };
	}
	let { data }: Props = $props();

	let qrCanvas: HTMLCanvasElement | undefined = $state();
	let qrError = $state('');

	onMount(() => {
		if (!qrCanvas) return;
		try {
			// Same renderer as /manufacturing/print-barcodes. The QR payload is
			// the bare code — that is what a keyboard-wedge gun types into a scan box.
			bwipjs.toCanvas(qrCanvas, { bcid: 'qrcode', text: data.badge.code, scale: 8 });
		} catch (e) {
			qrError = e instanceof Error ? e.message : String(e);
		}
	});
</script>

<svelte:head><title>Badge — {data.badge.displayName}</title></svelte:head>

<div class="space-y-4">
	<div class="no-print flex flex-wrap items-center justify-between gap-2">
		<div>
			<h3 class="text-base font-semibold text-[var(--color-tron-text)]">Print badge</h3>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">One CR80 card (85.6 × 54 mm). Print at 100% scale, no fit-to-page; cut on the outline and slide into a badge holder.</p>
		</div>
		<div class="flex gap-2">
			<a href="/admin/badges" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/60">← Badges</a>
			<button type="button" onclick={() => window.print()} class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-4 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)]">Print</button>
		</div>
	</div>

	{#if qrError}<p class="no-print text-xs text-[var(--color-tron-error)]">QR failed to render: {qrError}</p>{/if}

	<div class="badge-card">
		{#if data.badge.status === 'revoked'}<div class="revoked">REVOKED</div>{/if}
		<div class="name">{data.badge.displayName}</div>
		<div class="qr"><canvas bind:this={qrCanvas}></canvas></div>
		<div class="code">{data.badge.code}</div>
		<div class="brand">BIMS · {data.badge.username ?? ''}</div>
	</div>
</div>

<style>
	/* CR80 card, printed 1:1. Screen shows it on a dark page; print strips everything else. */
	.badge-card {
		position: relative;
		width: 85.6mm;
		height: 54mm;
		box-sizing: border-box;
		padding: 3mm 4mm;
		border: 0.3mm solid #999;
		border-radius: 3mm;
		background: #fff;
		color: #111;
		display: grid;
		grid-template-rows: auto 1fr auto auto;
		justify-items: center;
		align-items: center;
		text-align: center;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		overflow: hidden;
	}
	.name { font-size: 5.2mm; font-weight: 700; line-height: 1.1; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.qr { display: flex; align-items: center; justify-content: center; min-height: 0; }
	.qr canvas { height: 30mm; width: 30mm; image-rendering: pixelated; }
	.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 3.2mm; letter-spacing: 0.3mm; }
	.brand { font-size: 2.4mm; color: #666; }
	.revoked {
		position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
		font-size: 12mm; font-weight: 900; color: rgba(200, 0, 0, 0.35); transform: rotate(-20deg); pointer-events: none;
	}
	@media print {
		:global(body *) { visibility: hidden; }
		.badge-card, .badge-card * { visibility: visible; }
		.badge-card { position: absolute; left: 10mm; top: 10mm; border-color: #bbb; }
		.no-print { display: none; }
	}
</style>
