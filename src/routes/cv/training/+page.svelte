<script lang="ts">
	let { data } = $props();
	let trainingProject = $state<string | null>(null);
	let trainStatus = $state<Record<string, any>>({});

	const statusColors: Record<string, string> = {
		untrained: 'var(--color-tron-text-secondary)',
		training: 'var(--color-tron-yellow)',
		trained: 'var(--color-tron-green)',
		failed: 'var(--color-tron-red)'
	};

	async function startTraining(projectId: string) {
		trainingProject = projectId;
		try {
			const res = await fetch('/api/cv/train', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId })
			});
			const json = await res.json();
			if (!res.ok) {
				trainStatus[projectId] = { status: 'failed', message: json.error };
				trainingProject = null;
				return;
			}
			trainStatus[projectId] = { status: 'training', progress: 0, message: 'Started...' };
			pollStatus(projectId);
		} catch (err: any) {
			trainStatus[projectId] = { status: 'failed', message: err.message };
			trainingProject = null;
		}
	}

	function pollStatus(projectId: string) {
		const timer = setInterval(async () => {
			try {
				const res = await fetch(`/api/cv/train?projectId=${projectId}`);
				const json = await res.json();
				trainStatus[projectId] = json.data;
				trainStatus = { ...trainStatus };
				if (json.data.status === 'complete' || json.data.status === 'failed') {
					clearInterval(timer);
					trainingProject = null;
				}
			} catch { /* retry */ }
		}, 3000);
	}
</script>

<div class="space-y-6">
	<h2 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Training Overview</h2>

	<!-- Summary -->
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-text-primary)]">{data.projects.length}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Total Projects</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-green)]">{data.projects.filter((p: any) => p.modelStatus === 'trained').length}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Trained</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-yellow)]">{data.projects.filter((p: any) => p.modelStatus === 'training').length}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">In Progress</div>
		</div>
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-center">
			<div class="text-2xl font-bold text-[var(--color-tron-red)]">{data.projects.filter((p: any) => p.modelStatus === 'failed').length}</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">Failed</div>
		</div>
	</div>

	<!-- Per-project training cards -->
	<div class="space-y-4">
		{#each data.projects as project (project._id)}
			{@const stats = data.projectStats[project._id] || { approved: 0, rejected: 0, unlabeled: 0 }}
			{@const totalLabeled = stats.approved + stats.rejected}
			{@const status = trainStatus[project._id]}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
				<div class="flex items-center justify-between">
					<div>
						<a href="/cv/projects/{project._id}" class="text-lg font-semibold text-[var(--color-tron-text-primary)] hover:text-[var(--color-tron-cyan)]">
							{project.name}
						</a>
						<span
							class="ml-2 rounded-full px-2 py-0.5 text-xs font-semibold"
							style="color: {statusColors[project.modelStatus]}; background: color-mix(in srgb, {statusColors[project.modelStatus]} 20%, transparent)"
						>
							{project.modelStatus?.toUpperCase()}
						</span>
					</div>
					<button
						class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-1.5 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
						disabled={trainingProject === project._id || totalLabeled < 5}
						onclick={() => startTraining(project._id)}
					>
						{trainingProject === project._id ? 'Training...' : 'Start Training'}
					</button>
				</div>

				<!-- Stats bar -->
				<div class="mt-3 flex gap-4 text-xs text-[var(--color-tron-text-secondary)]">
					<span><span class="font-semibold text-[var(--color-tron-green)]">{stats.approved}</span> good</span>
					<span><span class="font-semibold text-[var(--color-tron-red)]">{stats.rejected}</span> defect</span>
					<span><span class="font-semibold text-[var(--color-tron-text-primary)]">{stats.unlabeled}</span> unlabeled</span>
					<span>{project.imageCount || 0} total</span>
				</div>

				{#if totalLabeled < 5}
					<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">Need at least 5 labeled images to train.</p>
				{/if}

				<!-- Training progress -->
				{#if status}
					<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3">
						<div class="mb-1 flex items-center justify-between text-xs">
							<span class="text-[var(--color-tron-text-secondary)]">{status.message || ''}</span>
							<span class="font-semibold" style="color: {status.status === 'complete' ? 'var(--color-tron-green)' : status.status === 'failed' ? 'var(--color-tron-red)' : 'var(--color-tron-yellow)'}">
								{status.status?.toUpperCase()}
							</span>
						</div>
						{#if status.progress !== undefined && status.status === 'training'}
							<div class="h-1.5 overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
								<div class="h-full rounded-full bg-gradient-to-r from-[var(--color-tron-cyan)] to-[var(--color-tron-green)] transition-all" style="width: {Math.round(status.progress * 100)}%"></div>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
