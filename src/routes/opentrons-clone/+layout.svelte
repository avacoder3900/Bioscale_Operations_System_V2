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
			<h1 class="text-lg font-semibold">Opentrons Clone</h1>
			<div class="flex items-center gap-3">
				<span class="text-xs ot-muted">In-BIMS clone of the Opentrons App</span>
				{#if data?.operatorAuthed}
					<form method="POST" action="/opentrons-clone/operator-logout">
						<button type="submit" class="text-xs px-2 py-1 rounded border hover:bg-slate-700">Lock</button>
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
					class="py-2 border-b-2 {active ? 'border-blue-500 text-blue-400' : 'border-transparent ot-muted hover:text-slate-100'}"
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
	/* Dark-mode override scoped to /opentrons-clone/** only. Applied via
	   :global() so it re-colors Tailwind utility classes used in every
	   descendant page without needing to edit those files. */

	.ot-dark {
		background: #0f172a; /* slate-900 */
		color: #e2e8f0; /* slate-200 */
		color-scheme: dark;
	}
	.ot-dark .ot-header {
		background: #1e293b; /* slate-800 */
		border-color: #334155; /* slate-700 */
	}
	.ot-dark .ot-border {
		border-color: #334155;
	}
	.ot-dark .ot-muted {
		color: #94a3b8; /* slate-400 */
	}

	/* Surfaces */
	.ot-dark :global(.bg-white) { background-color: #1e293b !important; }
	.ot-dark :global(.bg-gray-50) { background-color: #0f172a !important; }
	.ot-dark :global(.bg-gray-100) { background-color: #1e293b !important; }
	.ot-dark :global(.bg-gray-200) { background-color: #334155 !important; }

	/* Tinted info/warn/success cards */
	.ot-dark :global(.bg-blue-50) { background-color: rgba(37, 99, 235, 0.15) !important; }
	.ot-dark :global(.bg-blue-100) { background-color: rgba(37, 99, 235, 0.25) !important; }
	.ot-dark :global(.bg-green-50) { background-color: rgba(22, 163, 74, 0.15) !important; }
	.ot-dark :global(.bg-green-100) { background-color: rgba(22, 163, 74, 0.22) !important; }
	.ot-dark :global(.bg-green-200) { background-color: rgba(22, 163, 74, 0.35) !important; }
	.ot-dark :global(.bg-red-50) { background-color: rgba(220, 38, 38, 0.15) !important; }
	.ot-dark :global(.bg-red-100) { background-color: rgba(220, 38, 38, 0.25) !important; }
	.ot-dark :global(.bg-red-200) { background-color: rgba(220, 38, 38, 0.35) !important; }
	.ot-dark :global(.bg-amber-50) { background-color: rgba(217, 119, 6, 0.15) !important; }
	.ot-dark :global(.bg-amber-100) { background-color: rgba(217, 119, 6, 0.25) !important; }
	.ot-dark :global(.bg-yellow-100) { background-color: rgba(234, 179, 8, 0.25) !important; }
	.ot-dark :global(.bg-yellow-200) { background-color: rgba(234, 179, 8, 0.35) !important; }

	/* Text — lift grays */
	.ot-dark :global(.text-gray-900) { color: #f1f5f9 !important; } /* slate-100 */
	.ot-dark :global(.text-gray-700) { color: #cbd5e1 !important; } /* slate-300 */
	.ot-dark :global(.text-gray-600) { color: #94a3b8 !important; } /* slate-400 */
	.ot-dark :global(.text-gray-500) { color: #94a3b8 !important; }
	.ot-dark :global(.text-gray-400) { color: #64748b !important; } /* slate-500 */

	/* Accent text — brighten so it reads on dark */
	.ot-dark :global(.text-blue-600) { color: #60a5fa !important; }
	.ot-dark :global(.text-blue-700) { color: #60a5fa !important; }
	.ot-dark :global(.text-red-600) { color: #f87171 !important; }
	.ot-dark :global(.text-red-700) { color: #f87171 !important; }
	.ot-dark :global(.text-red-800) { color: #fca5a5 !important; }
	.ot-dark :global(.text-red-900) { color: #fecaca !important; }
	.ot-dark :global(.text-green-600) { color: #4ade80 !important; }
	.ot-dark :global(.text-green-700) { color: #4ade80 !important; }
	.ot-dark :global(.text-green-900) { color: #bbf7d0 !important; }

	/* Borders */
	.ot-dark :global(.border),
	.ot-dark :global(.border-t),
	.ot-dark :global(.border-b),
	.ot-dark :global(.border-l),
	.ot-dark :global(.border-r) { border-color: #334155 !important; }
	.ot-dark :global(.border-blue-200) { border-color: #1e40af !important; }
	.ot-dark :global(.border-green-300) { border-color: #166534 !important; }
	.ot-dark :global(.border-red-300) { border-color: #991b1b !important; }

	/* Buttons that are meant to be primary stay vibrant */
	.ot-dark :global(.bg-blue-600) { background-color: #2563eb !important; }
	.ot-dark :global(.bg-blue-700) { background-color: #1d4ed8 !important; }
	.ot-dark :global(.bg-red-600) { background-color: #dc2626 !important; }
	.ot-dark :global(.bg-red-700) { background-color: #b91c1c !important; }

	/* Form inputs */
	.ot-dark :global(input[type="text"]),
	.ot-dark :global(input[type="number"]),
	.ot-dark :global(input[type="search"]),
	.ot-dark :global(textarea),
	.ot-dark :global(select) {
		background-color: #0f172a;
		color: #e2e8f0;
		border-color: #334155;
	}
	.ot-dark :global(input::placeholder),
	.ot-dark :global(textarea::placeholder) {
		color: #64748b;
	}

	/* Tables — most <table> rows use bg-white / odd:bg-gray-50 already handled above */
	.ot-dark :global(table) { color: inherit; }
	.ot-dark :global(th) { color: #cbd5e1; }

	/* Code/pre (logs) */
	.ot-dark :global(pre),
	.ot-dark :global(code) {
		background-color: #020617 !important;
		color: #e2e8f0 !important;
	}
</style>
