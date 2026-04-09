/**
 * Print Barcodes — Generate cartridge barcode labels for Avery 94102 sheets.
 * 80 labels per sheet, 10 columns × 8 rows, each label 0.75" × 0.75" square.
 *
 * Flow: enter quantity → generate barcodes + QR codes → preview → print
 */
import { redirect, fail } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { generateBarcode } from '$lib/server/services/barcode-generator';
import QRCode from 'qrcode';
import type { PageServerLoad, Actions } from './$types';

const LABELS_PER_SHEET = 80;
const COLS = 10;
const ROWS = 8;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	return { labelsPerSheet: LABELS_PER_SHEET, cols: COLS, rows: ROWS };
};

export const actions: Actions = {
	generate: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const quantity = Number(data.get('quantity') || 0);
		const prefix = (data.get('prefix') as string)?.trim() || 'CART';

		if (quantity <= 0 || quantity > 800) {
			return fail(400, { error: 'Enter a quantity between 1 and 800' });
		}

		const labels: { barcode: string; qr: string }[] = [];

		for (let i = 0; i < quantity; i++) {
			const barcode = await generateBarcode(prefix, 'cartridge');
			// Use SVG string — no canvas dependency needed on serverless
			const svgString = await QRCode.toString(barcode, {
				type: 'svg',
				width: 96,
				margin: 0,
				errorCorrectionLevel: 'M'
			});
			const qr = `data:image/svg+xml;base64,${Buffer.from(svgString).toString('base64')}`;
			labels.push({ barcode, qr });
		}

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
