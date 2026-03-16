<script lang="ts">
	import { TronCard, TronButton } from '$lib/components/ui';
</script>

<div class="tron-grid-bg min-h-screen bg-[var(--color-tron-bg-primary)]">
	<div class="mx-auto max-w-6xl px-4 py-12">
		<header class="mb-12 text-center">
			<h1 class="mb-2 text-4xl font-bold text-[var(--color-tron-cyan)]">
				Bioscale Internal Management System
			</h1>
			<p class="tron-text-muted text-lg">Production Management & Traceability Platform</p>
		</header>

		<div class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
			<a href="/spu" class="block">
				<TronCard interactive>
					<div class="py-6 text-center">
						<div
							class="bg-opacity-20 mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-tron-cyan)]"
						>
							<svg
								class="h-8 w-8 text-[var(--color-tron-cyan)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
								/>
							</svg>
						</div>
						<h2 class="tron-text-primary mb-2 text-xl font-bold">Bioscale Management System</h2>
						<p class="tron-text-muted text-sm">
							Manufacturing, assembly, cartridges, and operations
						</p>
					</div>
				</TronCard>
			</a>

			<a href="/login" class="block">
				<TronCard interactive>
					<div class="py-6 text-center">
						<div
							class="bg-opacity-20 mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-tron-green)]"
						>
							<svg
								class="h-8 w-8 text-[var(--color-tron-green)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
								/>
							</svg>
						</div>
						<h2 class="tron-text-primary mb-2 text-xl font-bold">Login</h2>
						<p class="tron-text-muted text-sm">Sign in to access the system</p>
					</div>
				</TronCard>
			</a>

			<TronCard>
				<div class="py-6 text-center">
					<div
						class="bg-opacity-20 mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-tron-orange)]"
					>
						<svg
							class="h-8 w-8 text-[var(--color-tron-orange)]"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
							/>
						</svg>
					</div>
					<h2 class="tron-text-primary mb-2 text-xl font-bold">Reports</h2>
					<p class="tron-text-muted text-sm">Coming soon</p>
				</div>
			</TronCard>
		</div>

		<footer class="tron-text-muted mt-16 text-center text-sm">
			<p>Bioscale Internal Management System &copy; {new Date().getFullYear()}</p>
			<p class="mt-1">ISO 13485 / FDA 21 CFR Part 820 Compliant</p>
		</footer>
	</div>
</div>
