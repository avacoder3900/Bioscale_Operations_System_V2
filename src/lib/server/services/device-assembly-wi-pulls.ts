import { DeviceAssemblyWI, DeviceAssemblyMaterialPull, InventoryTransaction, PartDefinition, AuditLog } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import { recordTransaction } from './inventory-transaction';
import { DEVICE_WI_DOCUMENT_NUMBER, findSection, findStep, sectionLabel, type Actor } from './device-assembly-wi';

// Material consumption for a SPU Assembly WI step.
//
// Each selected material becomes one InventoryTransaction (consumption) via
// the shared recordTransaction() helper — which is what decrements
// PartDefinition.inventoryCount, fires low-stock alerts and the kanban
// replenishment check — plus one immutable DeviceAssemblyMaterialPull row that
// ties the movement back to the WI section/step for the page's history.

export type PullItem = { materialId: string; quantity: number };

export type PullResult = {
	materialId: string;
	name: string;
	partNumber: string | null;
	quantity: number;
	unit: string;
	previousQuantity: number | null;
	newQuantity: number | null;
	inventoryTransactionId: string;
};

export async function pullMaterialsForStep(
	input: { sectionNumber: number; stepId: string; items: PullItem[]; unitsBuilt?: number; deviceSerial?: string | null; notes?: string | null },
	actor: Actor
): Promise<{ results: PullResult[]; stepNumber: number; sectionTitle: string }> {
	const wi: any = await DeviceAssemblyWI.findOne({ documentNumber: DEVICE_WI_DOCUMENT_NUMBER }).lean();
	if (!wi) throw new Error('No SPU Assembly Work Instruction has been imported yet');
	const section = findSection(wi, input.sectionNumber);
	if (!section) throw new Error(`Section ${input.sectionNumber} not found`);
	const step = findStep(section, { stepId: input.stepId });
	if (!step) throw new Error(`Step not found in ${sectionLabel(section)}`);
	if (!input.items.length) throw new Error('Select at least one material to pull');

	// Validate everything first so a bad row never leaves a half-applied pull.
	const planned: { material: any; quantity: number; partDefinitionId: string }[] = [];
	const errors: string[] = [];
	for (const item of input.items) {
		const material = (step.materials ?? []).find((m: any) => m._id === item.materialId);
		if (!material) { errors.push(`Material ${item.materialId} is not on this step`); continue; }
		if (!(item.quantity > 0) || !Number.isFinite(item.quantity)) { errors.push(`${material.name}: quantity must be greater than 0`); continue; }
		let partDefinitionId: string | null = material.partDefinitionId ?? null;
		if (!partDefinitionId && material.partNumber) {
			const part = await PartDefinition.findOne({ partNumber: String(material.partNumber).toUpperCase() }).select('_id').lean() as any;
			partDefinitionId = part ? String(part._id) : null;
		}
		if (!partDefinitionId) { errors.push(`${material.name}${material.partNumber ? ` (${material.partNumber})` : ''} is not linked to a part in the catalog — link it first`); continue; }
		planned.push({ material, quantity: item.quantity, partDefinitionId });
	}
	if (errors.length) throw new Error(errors.join('; '));

	const unitsBuilt = input.unitsBuilt && input.unitsBuilt > 0 ? input.unitsBuilt : 1;
	const serial = input.deviceSerial?.trim() || null;
	const where = `${sectionLabel(section)} step ${step.stepNumber}`;
	const now = new Date();
	const results: PullResult[] = [];

	for (const p of planned) {
		const noteParts = [`SPU Assembly WI ${wi.documentNumber} ${`v${wi.currentVersion}`} — ${where}: ${p.material.name}`];
		if (serial) noteParts.push(`SPU ${serial}`);
		if (input.notes?.trim()) noteParts.push(input.notes.trim());
		const txId = await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: p.partDefinitionId,
			quantity: p.quantity,
			operatorId: actor._id,
			operatorUsername: actor.username,
			notes: noteParts.join(' · ')
		});
		const tx = await InventoryTransaction.findById(txId).select('previousQuantity newQuantity').lean() as any;
		await DeviceAssemblyMaterialPull.create({
			_id: generateId(),
			wiId: String(wi._id),
			wiVersion: wi.currentVersion,
			sectionNumber: section.number,
			sectionTitle: section.title,
			stepId: step._id,
			stepNumber: step.stepNumber,
			materialId: p.material._id,
			partDefinitionId: p.partDefinitionId,
			partNumber: p.material.partNumber ?? null,
			name: p.material.name,
			quantity: p.quantity,
			unit: p.material.unit ?? 'ea',
			unitsBuilt,
			deviceSerial: serial,
			inventoryTransactionId: txId,
			previousQuantity: tx?.previousQuantity ?? null,
			newQuantity: tx?.newQuantity ?? null,
			performedBy: actor,
			performedAt: now,
			notes: input.notes?.trim() ?? ''
		});
		results.push({
			materialId: p.material._id,
			name: p.material.name,
			partNumber: p.material.partNumber ?? null,
			quantity: p.quantity,
			unit: p.material.unit ?? 'ea',
			previousQuantity: tx?.previousQuantity ?? null,
			newQuantity: tx?.newQuantity ?? null,
			inventoryTransactionId: txId
		});
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'inventory_transactions',
		recordId: String(wi._id),
		action: 'INSERT',
		newData: {
			operation: 'device_assembly_material_pull',
			wi: wi.documentNumber,
			version: wi.currentVersion,
			section: sectionLabel(section),
			stepNumber: step.stepNumber,
			unitsBuilt,
			deviceSerial: serial,
			parts: results.map((r) => ({ partNumber: r.partNumber, name: r.name, quantity: r.quantity, from: r.previousQuantity, to: r.newQuantity }))
		},
		changedAt: now,
		changedBy: actor.username
	});

	return { results, stepNumber: step.stepNumber, sectionTitle: section.title };
}

export async function getRecentPulls(wiId: string, limit = 200): Promise<any[]> {
	const rows = await DeviceAssemblyMaterialPull.find({ wiId }).sort({ performedAt: -1 }).limit(limit).lean();
	return JSON.parse(JSON.stringify(rows));
}
