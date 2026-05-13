import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { hasPermission } from '$lib/server/permissions';
import { getActiveSpuWorkInstruction } from '$lib/server/services/spu-work-instruction';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, locals }) => {
	const apiKey =
		request.headers.get('x-api-key') || request.headers.get('x-agent-api-key');
	const isAgent = !!apiKey && !!env.AGENT_API_KEY && apiKey === env.AGENT_API_KEY;
	const isUser = !!locals.user && hasPermission(locals.user, 'spu:read');

	if (!isAgent && !isUser) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const wi: any = await getActiveSpuWorkInstruction();
	if (!wi) return json({ error: 'No active SPU work instruction' }, { status: 404 });

	const activeVersion = (wi.versions ?? []).find((v: any) => v.version === wi.currentVersion);
	if (!activeVersion) return json({ error: 'Active version missing' }, { status: 500 });

	const steps = (activeVersion.steps ?? []).map((s: any) => ({
		stepNumber: s.stepNumber,
		title: s.title,
		content: s.content,
		partRequirements: (s.partRequirements ?? []).map((p: any) => ({
			partNumber: p.partNumber,
			quantity: p.quantity
		})),
		fieldDefinitions: (s.fieldDefinitions ?? []).map((f: any) => ({
			fieldName: f.fieldName,
			fieldLabel: f.fieldLabel,
			fieldType: f.fieldType,
			isRequired: !!f.isRequired,
			barcodeFieldMapping: f.barcodeFieldMapping ?? undefined,
			sortOrder: f.sortOrder ?? 0
		}))
	}));

	const totalRequiredScans = steps.reduce(
		(n: number, s: any) => n + (s.fieldDefinitions ?? []).length,
		0
	);

	return json({
		workInstructionId: wi._id,
		version: wi.currentVersion,
		title: wi.title,
		revision: wi.revision ?? '',
		effectiveDate: wi.effectiveDate ?? null,
		fileId: wi.fileId ?? null,
		steps,
		totalRequiredScans
	});
};
