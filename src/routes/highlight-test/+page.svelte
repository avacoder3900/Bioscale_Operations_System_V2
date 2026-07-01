<script lang="ts">
	/**
	 * TEMPORARY test harness for PhotoHighlighter — not part of the feature.
	 * Public route (added to PUBLIC_PATHS in hooks.server.ts) so it can be opened
	 * without login. Remove this route + the hooks entry after testing.
	 */
	import PhotoHighlighter from '$lib/components/PhotoHighlighter.svelte';

	const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='900' height='620'>
		<rect width='900' height='620' fill='#0f172a'/>
		<g stroke='#1e293b' stroke-width='1'>
			${Array.from({ length: 18 }, (_, i) => `<line x1='${i * 50}' y1='0' x2='${i * 50}' y2='620'/>`).join('')}
			${Array.from({ length: 13 }, (_, i) => `<line x1='0' y1='${i * 50}' x2='900' y2='${i * 50}'/>`).join('')}
		</g>
		<rect x='250' y='170' width='400' height='280' rx='18' fill='#0b3a4a' stroke='#22d3ee' stroke-width='3'/>
		<circle cx='450' cy='310' r='70' fill='#155e75' stroke='#67e8f9' stroke-width='3'/>
		<text x='450' y='560' fill='#94a3b8' font-family='sans-serif' font-size='26' text-anchor='middle'>Sample photo — click Highlight, then drag corner to corner</text>
	</svg>`;
	const SAMPLE = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

	let src = $state(SAMPLE);

	function onFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) src = URL.createObjectURL(file);
	}
	function reset() {
		src = SAMPLE;
	}
</script>

<div class="min-h-screen bg-[#0a0e14] p-6 text-white">
	<div class="mx-auto max-w-4xl space-y-4">
		<div>
			<h1 class="text-2xl font-bold text-[#22d3ee]">Highlight tool — test harness</h1>
			<p class="text-sm text-slate-400">
				Temporary page. Click <strong>Highlight</strong>, then click two opposite corners to drop a
				yellow outline box. Hover a box for its ✕, or use <strong>Clear</strong>. Load your own
				photo to try it on a real capture.
			</p>
		</div>

		<div class="flex items-center gap-3">
			<input
				type="file"
				accept="image/*"
				onchange={onFile}
				class="text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-[#22d3ee] file:px-3 file:py-1.5 file:text-black"
			/>
			<button type="button" onclick={reset} class="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:border-[#22d3ee]">
				Reset to sample
			</button>
		</div>

		<div class="rounded-lg border border-slate-700 bg-black/40 p-4">
			<PhotoHighlighter
				{src}
				alt="test"
				imgClass="block max-h-[70vh] w-auto rounded border border-white/10"
			/>
		</div>
	</div>
</div>
