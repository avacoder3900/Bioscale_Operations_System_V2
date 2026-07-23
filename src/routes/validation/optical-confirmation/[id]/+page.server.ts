import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AssayDefinition, AnalysisProfile } from '$lib/server/db';
import {
	computeAnalysis, detectScanGroupsFromBCODE, buildManualScanGroups,
	type AnalysisProfileConfig, type CartridgeAnalysis, type ScanGroupDefinition
} from '$lib/server/optical-engine';
import type { PageServerLoad } from './$types';

// Per-cartridge optical data view: raw readings + the research app's analysis
// engine run live against the shared analysis_profiles collection, so BIMS
// shows the same per-channel numbers (f3/f7 raws, f7/f3 ratios, …) the
// research app computes. cartridge_records `_id` IS the scanned barcode.
export const load: PageServerLoad = async ({ params, locals, url }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const cartridge = await CartridgeRecord.findById(params.id).lean() as any;
	if (!cartridge) {
		throw error(404, `Cartridge ${params.id} not found`);
	}

	const readings: any[] = Array.isArray(cartridge?.rawData?.readings)
		? cartridge.rawData.readings
		: [];

	const profiles = await AnalysisProfile.find()
		.sort({ name: 1 })
		.lean() as any[];

	// Assay BCODE drives scan-group detection (same as the research app)
	const assayId: string | null = cartridge.assayId || cartridge.assay?._id || null;
	const assay = assayId
		? await AssayDefinition.findById(assayId).select('name BCODE.code').lean() as any
		: null;

	// Profile precedence: explicit ?profile= → the profile of the stored
	// research-app result → the Gen 5 default → first available.
	const storedAnalysis = cartridge.analysis?.profileId ? cartridge.analysis : null;
	const requestedId = url.searchParams.get('profile');
	const profileDoc =
		profiles.find(p => p._id === requestedId)
		?? profiles.find(p => p._id === storedAnalysis?.profileId)
		?? profiles.find(p => p.name === 'Single Scan Cortisol')
		?? profiles[0]
		?? null;

	let liveAnalysis: CartridgeAnalysis | null = null;
	if (profileDoc && readings.length > 0) {
		const profile = profileDoc as unknown as AnalysisProfileConfig;
		let scanGroups: ScanGroupDefinition[] =
			profile.scanGroupDetection === 'manual' && (profile.manualScanGroups?.length ?? 0) > 0
				? buildManualScanGroups(profile.manualScanGroups, profile.scanGroupLabels ?? [])
				: detectScanGroupsFromBCODE(assay?.BCODE?.code ?? [], profile.scanGroupLabels ?? []);
		// No BCODE available (or nothing detected): treat the whole run as one group
		if (scanGroups.length === 0) {
			const maxNumber = readings.reduce((m, r) => Math.max(m, r.number ?? 0), 0);
			scanGroups = [{ label: 'All Scans', scanCount: maxNumber + 1, startIndex: 0 }];
		}
		liveAnalysis = computeAnalysis(readings, scanGroups, profile, {
			profileId: profile._id,
			profileName: profile.name,
			computedBy: 'BIMS (live)'
		});
	}

	return {
		barcode: params.id,
		assayName: cartridge.assayName ?? assay?.name ?? cartridge.assayId ?? null,
		status: cartridge.status ?? 'linked',
		spuUdi: cartridge.device?.name ?? null,
		completedAt: cartridge.checkpoints?.completed?.when ?? null,
		liveAnalysis,
		storedAnalysis: storedAnalysis ? JSON.parse(JSON.stringify(storedAnalysis)) : null,
		profiles: profiles.map(p => ({ id: p._id, name: p.name, description: p.description ?? '' })),
		selectedProfileId: profileDoc?._id ?? null,
		readings: JSON.parse(JSON.stringify(readings)),
		rawData: JSON.parse(JSON.stringify(cartridge.rawData ?? null))
	};
};
