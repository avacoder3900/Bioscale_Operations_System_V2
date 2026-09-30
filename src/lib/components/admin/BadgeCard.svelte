<script lang="ts">
	// One CR80 badge card (85.6 × 54 mm), printed 1:1 — BADGE-SYSTEM_PLAN.md §17.2.
	// Shared by the single-badge print page and the batch print sheet.
	import { onMount } from 'svelte';
	import bwipjs from 'bwip-js/browser';

	interface Props {
		code: string;
		displayName: string;
		username?: string | null;
		status: 'active' | 'revoked';
	}
	let { code, displayName, username = null, status }: Props = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let qrError = $state('');

	onMount(() => {
		if (!canvas) return;
		try {
			// Same renderer as /manufacturing/print-barcodes. The QR payload is the
			// bare code — that is what a keyboard-wedge gun types into a scan box.
			bwipjs.toCanvas(canvas, { bcid: 'qrcode', text: code, scale: 8 });
		} catch (e) {
			qrError = e instanceof Error ? e.message : String(e);
		}
	});
</script>

<div class="badge-card">
	{#if status === 'revoked'}<div class="revoked">REVOKED</div>{/if}
	<div class="name">{displayName}</div>
	<div class="qr">
		{#if qrError}<div class="qr-error">QR failed: {qrError}</div>{:else}<canvas bind:this={canvas}></canvas>{/if}
	</div>
	<div class="code">{code}</div>
	<div class="brand">BIMS{username ? ` · ${username}` : ''}</div>
</div>

<style>
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
		break-inside: avoid;
		page-break-inside: avoid;
	}
	.name { font-size: 5.2mm; font-weight: 700; line-height: 1.1; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.qr { display: flex; align-items: center; justify-content: center; min-height: 0; }
	.qr canvas { height: 30mm; width: 30mm; image-rendering: pixelated; }
	.qr-error { font-size: 2.5mm; color: #b00; }
	.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 3.2mm; letter-spacing: 0.3mm; }
	.brand { font-size: 2.4mm; color: #666; }
	.revoked {
		position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
		font-size: 12mm; font-weight: 900; color: rgba(200, 0, 0, 0.35); transform: rotate(-20deg); pointer-events: none;
	}
</style>
