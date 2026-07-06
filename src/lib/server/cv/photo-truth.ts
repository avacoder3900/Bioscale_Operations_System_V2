/**
 * Photo-truth helpers — the ONLY sanctioned write path for human QC data on
 * photos. All human truth (qcLabel, labels, notes, annotations) lives on
 * cartridge_records.photos[]; these helpers do targeted positional updates
 * so the rest of the sacred document is never touched.
 */
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';

export interface PhotoEntry {
	imageId: string;
	phase: string;
	capturedAt?: Date;
	capturedBy?: { _id: string; username: string };
	r2Key?: string;
	r2Url?: string;
	cartridgeImageNumber?: string;
	qcLabel?: 'approved' | 'rejected' | null;
	qcLabeledBy?: { _id: string; username: string } | null;
	qcLabeledAt?: Date | null;
	labels?: string[];
	notes?: string;
	annotations?: Array<{ x: number; y: number; w: number; h: number; tag?: string; color?: string }>;
}

/** Find the cartridge owning an imageId and return (cartridgeRecordId, entry). */
export async function getPhotoByImageId(
	imageId: string
): Promise<{ cartridgeRecordId: string; photo: PhotoEntry } | null> {
	const cart = (await CartridgeRecord.findOne({ 'photos.imageId': imageId })
		.select('_id photos')
		.lean()) as any;
	if (!cart) return null;
	const photo = (cart.photos ?? []).find((p: any) => p.imageId === imageId);
	return photo ? { cartridgeRecordId: cart._id, photo } : null;
}

/**
 * Targeted update of one photo entry's QC fields. Only the provided keys are
 * written. Returns false if no photo entry matched the imageId.
 */
export async function updatePhotoTruth(
	imageId: string,
	patch: Partial<Pick<PhotoEntry, 'qcLabel' | 'qcLabeledBy' | 'qcLabeledAt' | 'labels' | 'notes' | 'annotations' | 'r2Key' | 'r2Url'>>
): Promise<{ cartridgeRecordId: string } | null> {
	const set: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(patch)) {
		set[`photos.$[p].${k}`] = v;
	}
	if (Object.keys(set).length === 0) return null;

	const res = await CartridgeRecord.findOneAndUpdate(
		{ 'photos.imageId': imageId },
		{ $set: set },
		{ arrayFilters: [{ 'p.imageId': imageId }], new: false, projection: { _id: 1 } }
	).lean() as any;

	return res ? { cartridgeRecordId: res._id } : null;
}
