<script lang="ts">
	import { page } from '$app/stores';

	let { children, data } = $props<{ children: any; data?: { operatorAuthed?: boolean } }>();

	// Extract active robot id (if any) from /opentrons-clone/[robotId]/...
	const robotId = $derived.by(() => {
		const m = $page.url.pathname.match(/^\/opentrons-clone\/([^/]+)/);
		return m ? m[1] : null;
	});

	const tabs = $derived(
		robotId
			? [
					{ href: '/opentrons-clone', label: 'Robots' },
					{ href: `/opentrons-clone/${robotId}`, label: 'Overview' },
					{ href: `/opentrons-clone/${robotId}/protocols`, label: 'Protocols' },
					{ href: `/opentrons-clone/${robotId}/runs`, label: 'Runs' },
					{ href: `/opentrons-clone/${robotId}/labware`, label: 'Labware' },
					{ href: `/opentrons-clone/${robotId}/data-files`, label: 'Data files' },
					{ href: `/opentrons-clone/${robotId}/settings`, label: 'Settings' }
				]
			: [{ href: '/opentrons-clone', label: 'Robots' }]
	);
</script>

<div class="ot-dark min-h-screen">
	<header class="ot-header border-b">
		<div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
			<h1 class="text-lg font-semibold ot-heading">Opentrons Clone</h1>
			<div class="flex items-center gap-3">
				<span class="text-xs ot-muted">In-BIMS clone of the Opentrons App</span>
				{#if data?.operatorAuthed}
					<form method="POST" action="/opentrons-clone/operator-logout">
						<button type="submit" class="ot-lock-btn">Lock</button>
					</form>
				{/if}
			</div>
		</div>
		<nav class="max-w-6xl mx-auto px-4 flex gap-4 text-sm border-t ot-border">
			{#each tabs as tab (tab.href)}
				{@const active = tab.href === '/opentrons-clone'
					? $page.url.pathname === '/opentrons-clone'
					: $page.url.pathname === tab.href || $page.url.pathname.startsWith(tab.href + '/')}
				<a
					href={tab.href}
					class="ot-tab {active ? 'ot-tab-active' : ''}"
				>
					{tab.label}
				</a>
			{/each}
		</nav>
	</header>
	<main class="max-w-6xl mx-auto px-4 py-6">
		{@render children()}
	</main>
</div>

<style>
	/* Theme override scoped to /opentrons-clone/** only. Maps the clone's
	   Tailwind utility classes onto the BIMS TRON palette (see
	   src/routes/layout.css @theme block) so the clone matches the rest
	   of the app instead of using a generic slate/blue scheme. */

	.ot-dark {
		background: var(--color-tron-bg-primary);
		color: var(--color-tron-text-primary);
		color-scheme: dark;
	}
	.ot-dark .ot-header {
		background: var(--color-tron-bg-secondary);
		border-color: var(--color-tron-border);
	}
	.ot-dark .ot-border {
		border-color: var(--color-tron-border);
	}
	.ot-dark .ot-muted {
		color: var(--color-tron-text-secondary);
	}
	.ot-dark .ot-heading {
		color: var(--color-tron-cyan);
	}
	.ot-dark .ot-tab {
		padding: 0.5rem 0;
		border-bottom: 2px solid transparent;
		color: var(--color-tron-text-secondary);
		transition: color 0.15s, border-color 0.15s;
	}
	.ot-dark .ot-tab:hover {
		color: var(--color-tron-text-primary);
	}
	.ot-dark .ot-tab-active {
		color: var(--color-tron-cyan);
		border-bottom-color: var(--color-tron-cyan);
	}
	.ot-dark .ot-lock-btn {
		font-size: 0.75rem;
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		border: 1px solid var(--color-tron-border);
		color: var(--color-tron-text-secondary);
		background: transparent;
		transition: all 0.15s;
	}
	.ot-dark .ot-lock-btn:hover {
		border-color: var(--color-tron-cyan);
		color: var(--color-tron-text-primary);
		background: var(--color-tron-bg-tertiary);
	}

	/* =======================================================
	   Tailwind utility mappings → TRON palette
	   ======================================================= */

	/* Surfaces */
	.ot-dark :global(.bg-white) { background-color: var(--color-tron-bg-card) !important; }
	.ot-dark :global(.bg-gray-50) { background-color: var(--color-tron-bg-primary) !important; }
	.ot-dark :global(.bg-gray-100) { background-color: var(--color-tron-bg-secondary) !important; }
	.ot-dark :global(.bg-gray-200) { background-color: var(--color-tron-bg-tertiary) !important; }

	/* Tinted info/warn/success panels — subtle TRON-flavoured washes */
	.ot-dark :global(.bg-blue-50) { background-color: rgba(0, 212, 255, 0.07) !important; }
	.ot-dark :global(.bg-blue-100) { background-color: rgba(0, 212, 255, 0.15) !important; }
	.ot-dark :global(.bg-green-50) { background-color: rgba(0, 255, 136, 0.07) !important; }
	.ot-dark :global(.bg-green-100) { background-color: rgba(0, 255, 136, 0.15) !important; }
	.ot-dark :global(.bg-green-200) { background-color: rgba(0, 255, 136, 0.25) !important; }
	.ot-dark :global(.bg-red-50) { background-color: rgba(255, 51, 102, 0.08) !important; }
	.ot-dark :global(.bg-red-100) { background-color: rgba(255, 51, 102, 0.18) !important; }
	.ot-dark :global(.bg-red-200) { background-color: rgba(255, 51, 102, 0.28) !important; }
	.ot-dark :global(.bg-amber-50) { background-color: rgba(255, 194, 51, 0.08) !important; }
	.ot-dark :global(.bg-amber-100) { background-color: rgba(255, 194, 51, 0.18) !important; }
	.ot-dark :global(.bg-yellow-100) { background-color: rgba(255, 194, 51, 0.18) !important; }
	.ot-dark :global(.bg-yellow-200) { background-color: rgba(255, 194, 51, 0.28) !important; }

	/* Text — gray scale mapped to TRON text tokens */
	.ot-dark :global(.text-gray-900) { color: var(--color-tron-text-primary) !important; }
	.ot-dark :global(.text-gray-700) { color: var(--color-tron-text-primary) !important; }
	.ot-dark :global(.text-gray-600) { color: var(--color-tron-text-secondary) !important; }
	.ot-dark :global(.text-gray-500) { color: var(--color-tron-text-secondary) !important; }
	.ot-dark :global(.text-gray-400) { color: #707080 !important; }

	/* Accent text → TRON neon (mid values; dark 800/900 values become body text
	   because they usually live INSIDE a tinted panel where dark-on-dark is
	   unreadable — the body of a bg-blue-50 panel needs near-white text, not
	   dark navy).
	*/
	.ot-dark :global(.text-blue-600),
	.ot-dark :global(.text-blue-700) { color: var(--color-tron-cyan) !important; }
	.ot-dark :global(.text-blue-800),
	.ot-dark :global(.text-blue-900) { color: var(--color-tron-text-primary) !important; }
	.ot-dark :global(.text-red-600),
	.ot-dark :global(.text-red-700) { color: var(--color-tron-red) !important; }
	.ot-dark :global(.text-red-800),
	.ot-dark :global(.text-red-900) { color: #ffc9d4 !important; } /* light pink on red wash */
	.ot-dark :global(.text-green-600),
	.ot-dark :global(.text-green-700) { color: var(--color-tron-green) !important; }
	.ot-dark :global(.text-green-800),
	.ot-dark :global(.text-green-900) { color: #c6ffe0 !important; } /* light mint on green wash */
	.ot-dark :global(.text-amber-600),
	.ot-dark :global(.text-amber-700),
	.ot-dark :global(.text-yellow-600),
	.ot-dark :global(.text-yellow-700) { color: var(--color-tron-yellow) !important; }
	.ot-dark :global(.text-amber-800),
	.ot-dark :global(.text-amber-900),
	.ot-dark :global(.text-yellow-800),
	.ot-dark :global(.text-yellow-900) { color: #ffe9a8 !important; } /* light yellow on amber wash */

	/* Borders — cyan-tinted per the rest of BIMS */
	.ot-dark :global(.border),
	.ot-dark :global(.border-t),
	.ot-dark :global(.border-b),
	.ot-dark :global(.border-l),
	.ot-dark :global(.border-r) { border-color: var(--color-tron-border) !important; }
	.ot-dark :global(.border-blue-200) { border-color: rgba(0, 212, 255, 0.35) !important; }
	.ot-dark :global(.border-green-300) { border-color: rgba(0, 255, 136, 0.35) !important; }
	.ot-dark :global(.border-red-300) { border-color: rgba(255, 51, 102, 0.35) !important; }

	/* Primary + danger buttons — TRON cyan / red */
	.ot-dark :global(.bg-blue-600),
	.ot-dark :global(.bg-blue-700) {
		background-color: var(--color-tron-cyan) !important;
		color: var(--color-tron-bg-primary) !important;
	}
	.ot-dark :global(.bg-blue-600:hover),
	.ot-dark :global(.bg-blue-700:hover) {
		box-shadow: var(--shadow-tron-glow);
	}
	.ot-dark :global(.bg-red-600),
	.ot-dark :global(.bg-red-700) {
		background-color: var(--color-tron-red) !important;
		color: white !important;
	}

	/* Form inputs */
	.ot-dark :global(input[type="text"]),
	.ot-dark :global(input[type="number"]),
	.ot-dark :global(input[type="search"]),
	.ot-dark :global(input[type="password"]),
	.ot-dark :global(textarea),
	.ot-dark :global(select) {
		background-color: var(--color-tron-bg-primary);
		color: var(--color-tron-text-primary);
		border-color: var(--color-tron-border);
	}
	.ot-dark :global(input::placeholder),
	.ot-dark :global(textarea::placeholder) {
		color: #707080;
	}

	/* Tables */
	.ot-dark :global(table) { color: inherit; }
	.ot-dark :global(th) { color: var(--color-tron-text-secondary); }

	/* Code / logs */
	.ot-dark :global(pre),
	.ot-dark :global(code) {
		background-color: #05050a !important;
		color: var(--color-tron-text-primary) !important;
		border: 1px solid var(--color-tron-border);
	}
</style>
