<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form: formResult } = $props();
	let r = data.robot;
</script>

<div class="mx-auto max-w-3xl space-y-6 p-4">
	<!-- Breadcrumb -->
	<nav class="flex items-center gap-2 text-sm text-[var(--color-tron-text-secondary)]">
		<a href="/opentrons/devices" class="transition-colors hover:text-[var(--color-tron-cyan)]">Devices</a>
		<span>/</span>
		<a href="/opentrons/devices/{r.robotId}" class="transition-colors hover:text-[var(--color-tron-cyan)]">{r.name}</a>
		<span>/</span>
		<span class="text-[var(--color-tron-text)]">Edit</span>
	</nav>

	<h1 class="text-2xl font-semibold text-[var(--color-tron-text)]">Edit {r.name}</h1>

	{#if formResult?.error}
		<div class="rounded-md border border-red-700 bg-red-900/20 px-4 py-3 text-sm text-red-400">
			{formResult.error}
		</div>
	{/if}

	<form method="POST" use:enhance class="space-y-8">
		<!-- General Information -->
		<fieldset class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<legend class="px-2 text-lg font-medium text-[var(--color-tron-cyan)]">General Information</legend>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="name" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Robot Name *</label>
					<input id="name" name="name" type="text" value={r.name} required
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>

				<div>
					<label for="robotModel" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Robot Model</label>
					<select id="robotModel" name="robotModel"
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none">
						<option value="OT-2" selected={r.robotModel === 'OT-2'}>OT-2</option>
						<option value="Flex" selected={r.robotModel === 'Flex'}>Flex</option>
					</select>
				</div>

				<div>
					<label for="robotSerial" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Serial Number</label>
					<input id="robotSerial" name="robotSerial" type="text" value={r.robotSerial}
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>

				<div>
					<label for="robotSide" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Robot Side / Location</label>
					<input id="robotSide" name="robotSide" type="text" value={r.robotSide} placeholder="e.g. Left bench, Station A"
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>

				<div class="flex items-center gap-3">
					<input id="isActive" name="isActive" type="checkbox" checked={r.isActive}
						class="h-4 w-4 rounded border-[var(--color-tron-border)] bg-[var(--color-tron-bg)]" />
					<label for="isActive" class="text-sm font-medium text-[var(--color-tron-text-secondary)]">Active</label>
				</div>
			</div>
		</fieldset>

		<!-- Network Configuration -->
		<fieldset class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<legend class="px-2 text-lg font-medium text-[var(--color-tron-cyan)]">Network Configuration</legend>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="ip" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">IP Address</label>
					<input id="ip" name="ip" type="text" value={r.ip} placeholder="e.g. 192.168.1.100"
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>

				<div>
					<label for="port" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Port</label>
					<input id="port" name="port" type="number" value={r.port} min="1" max="65535"
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>
			</div>
		</fieldset>

		<!-- Pipette Configuration -->
		<fieldset class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<legend class="px-2 text-lg font-medium text-[var(--color-tron-cyan)]">Pipette Configuration</legend>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="leftPipette" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Left Mount Pipette</label>
					<input id="leftPipette" name="leftPipette" type="text" value={r.leftPipette} placeholder="e.g. P300 Single-Channel GEN2"
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>

				<div>
					<label for="rightPipette" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Right Mount Pipette</label>
					<input id="rightPipette" name="rightPipette" type="text" value={r.rightPipette} placeholder="e.g. P20 Single-Channel GEN2"
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>
			</div>
		</fieldset>

		<!-- Firmware & Software -->
		<fieldset class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<legend class="px-2 text-lg font-medium text-[var(--color-tron-cyan)]">Firmware & Software</legend>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="firmwareVersion" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Firmware Version</label>
					<input id="firmwareVersion" name="firmwareVersion" type="text" value={r.firmwareVersion} placeholder="e.g. v4.7.0"
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>

				<div>
					<label for="apiVersion" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">API Version</label>
					<input id="apiVersion" name="apiVersion" type="text" value={r.apiVersion} placeholder="e.g. 2.19"
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>
			</div>
		</fieldset>

		<!-- Calibration -->
		<fieldset class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<legend class="px-2 text-lg font-medium text-[var(--color-tron-cyan)]">Calibration</legend>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
				<div>
					<label for="deckCalibrationDate" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Deck Calibration Date</label>
					<input id="deckCalibrationDate" name="deckCalibrationDate" type="date" value={r.deckCalibrationDate}
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>

				<div>
					<label for="pipetteCalibrationDate" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Pipette Calibration Date</label>
					<input id="pipetteCalibrationDate" name="pipetteCalibrationDate" type="date" value={r.pipetteCalibrationDate}
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>

				<div>
					<label for="labwareCalibrationDate" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Labware Calibration Date</label>
					<input id="labwareCalibrationDate" name="labwareCalibrationDate" type="date" value={r.labwareCalibrationDate}
						class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none" />
				</div>
			</div>
		</fieldset>

		<!-- Deck Configuration -->
		<fieldset class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<legend class="px-2 text-lg font-medium text-[var(--color-tron-cyan)]">Deck Slot Configuration</legend>

			<div>
				<label for="deckSlotConfig" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">Deck Layout Description</label>
				<textarea id="deckSlotConfig" name="deckSlotConfig" rows="4" placeholder="e.g. Slot 1: Cartridge deck, Slot 10: Tube rack, Slot 11: Tip rack"
					class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none">{r.deckSlotConfig}</textarea>
			</div>
		</fieldset>

		<!-- Notes -->
		<fieldset class="space-y-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5">
			<legend class="px-2 text-lg font-medium text-[var(--color-tron-cyan)]">Notes</legend>

			<div>
				<label for="notes" class="mb-1 block text-sm font-medium text-[var(--color-tron-text-secondary)]">General Notes</label>
				<textarea id="notes" name="notes" rows="3" placeholder="Any additional information about this robot..."
					class="w-full rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-3 py-2 text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)] focus:outline-none">{r.notes}</textarea>
			</div>
		</fieldset>

		<!-- Actions -->
		<div class="flex items-center gap-4">
			<button type="submit"
				class="rounded bg-[var(--color-tron-cyan)] px-6 py-2 font-medium text-black transition-colors hover:bg-[var(--color-tron-cyan)]/80">
				Save Changes
			</button>
			<a href="/opentrons/devices/{r.robotId}"
				class="rounded border border-[var(--color-tron-border)] px-6 py-2 text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]">
				Cancel
			</a>
		</div>
	</form>
</div>
