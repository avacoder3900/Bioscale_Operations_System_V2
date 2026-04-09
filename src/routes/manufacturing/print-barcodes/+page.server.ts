/**
 * Print Barcodes — Generate cartridge barcode labels for Avery 5167 sheets.
 * 80 labels per sheet, 4 columns × 20 rows, each label 0.5" × 1.75".
 *
 * Flow: enter quantity → generate barcodes + QR codes → preview → print
 */
import { redirect, fail } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { generateBarcode } from '$lib/server/services/barcode-generator';
import QRCode from 'qrcode';
import type { PageServerLoad, Actions } from './$types';

const LABELS_PER_SHEET = 80;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	return { labelsPerSheet: LABELS_PER_SHEET };
};

export const actions: Actions = {
	generate: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const quantity = Number(data.get('quantity') || 0);
		const prefix = (data.get('prefix') as string)?.trim() || 'CART';

		if (quantity <= 0 || quantity > 300) {
			return fail(400, { error: 'Enter a quantity between 1 and 300' });
		}

		const labels: { barcode: string; qr: string }[] = [];

		for (let i = 0; i < quantity; i++) {
			const barcode = await generateBarcode(prefix, 'cartridge');
			const qr = await QRCode.toDataURL(barcode, {
				width: 120,
				margin: 1,
				errorCorrectionLevel: 'M'
			});
			labels.push({ barcode, qr });
		}

		// Calculate sheets needed
		const sheetsNeeded = Math.ceil(quantity / LABELS_PER_SHEET);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'barcode_generation',
			recordId: labels[0]?.barcode ?? '',
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: new Date(),
			newData: {
				quantity,
				prefix,
				sheetsNeeded,
				firstBarcode: labels[0]?.barcode,
				lastBarcode: labels[labels.length - 1]?.barcode
			}
		});

		return { labels, sheetsNeeded, quantity };
	}
};
