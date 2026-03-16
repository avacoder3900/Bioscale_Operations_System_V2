export interface CartridgeTag {
	cartridge_record_id: string;
	phase: string;
	labels: string[];
	notes: string;
}

export interface ImageResponse {
	id: string;
	sample_id: string;
	filename: string;
	file_path: string;
	thumbnail_path: string;
	width: number;
	height: number;
	file_size_bytes: number;
	camera_index: number;
	metadata: Record<string, unknown>;
	captured_at: string;
	image_url: string;
	cartridge_tag: CartridgeTag | null;
}

export interface SampleResponse {
	id: string;
	name: string;
	description: string;
	project: string;
	tags: string[];
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface Defect {
	type: string;
	location: string;
	severity: string;
}

export interface InspectionResponse {
	id: string;
	sample_id: string;
	image_id: string;
	inspection_type: string;
	status: InspectionStatus;
	result: InspectionResult;
	confidence_score: number | null;
	defects: Defect[];
	model_version: string;
	processing_time_ms: number | null;
	created_at: string;
	completed_at: string | null;
	cartridge_record_id: string | null;
	phase: string | null;
}

export interface CaptureAndInspectRequest {
	camera_index?: number;
	inspection_type?: string;
	metadata?: Record<string, unknown>;
}

export interface CaptureAndInspectResponse {
	image: ImageResponse;
	inspection: InspectionResponse;
}

export interface CameraInfo {
	index: number;
	name: string;
	is_open: boolean;
	width: number;
	height: number;
}

export interface DashboardStats {
	total_inspections: number;
	pass_count: number;
	fail_count: number;
	pending_count: number;
	pass_rate: number;
	recent_inspections: InspectionResponse[];
}

export type InspectionStatus = 'pending' | 'processing' | 'complete' | 'failed';
export type InspectionResult = 'pass' | 'fail' | null;

export const CARTRIDGE_PHASES = [
	'backing',
	'wax_filled',
	'reagent_filled',
	'inspected',
	'sealed',
	'oven_cured',
	'qaqc_released',
	'shipped',
	'testing',
	'completed'
] as const;

export type CartridgePhase = (typeof CARTRIDGE_PHASES)[number];

export const IMAGE_TAG_LABELS = [
	'wax_fill',
	'reagent_fill',
	'top_seal',
	'top_view',
	'side_view',
	'defect_crack',
	'defect_bubble',
	'defect_overflow',
	'final_qc',
	'reference'
] as const;
