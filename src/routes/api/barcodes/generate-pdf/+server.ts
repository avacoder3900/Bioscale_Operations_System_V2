/**
 * Generate a PDF of barcode labels for Avery 94102 sheets.
 *
 * Avery 94102 specs:
 *   Sheet: 8.5" × 11" (letter)
 *   Labels: 0.75" × 0.75" square
 *   Layout: 10 columns × 8 rows = 80 labels/sheet
 *   Top margin: 0.625"
 *   Left margin: 0.375"
 *   Horizontal pitch: 0.775" (label + gap)
 *   Vertical pitch: 1.21875" (label centered in row)
 *
 * POST body: { quantity: number, prefix: string }
 * Returns: application/pdf
 */
import { json } from '@sveltejs/kit';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as bwipjs from 'bwip-js';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { generateBarcode } from '$lib/server/services/barcode-generator';
import type { RequestHandler } from './$types';

const POINTS_PER_INCH = 72;

// Sheet dimensions (letter)
const PAGE_W = 8.5 * POINTS_PER_INCH;
const PAGE_H = 11 * POINTS_PER_INCH;

// Avery 94102 label layout
const COLS = 10;
const ROWS = 8;
const LABELS_PER_SHEET = COLS * ROWS;

const LABEL_W = 0.75 * POINTS_PER_INCH;  // 54pt
const LABEL_H = 0.75 * POINTS_PER_INCH;  // 54pt

// Margins (from Avery spec)
const MARGIN_TOP = 0.625 * POINTS_PER_INCH;
const MARGIN_LEFT = 0.375 * POINTS_PER_INCH;

// Pitch = distance from one label's left edge to the next
const H_PITCH = (PAGE_W - 2 * MARGIN_LEFT) / COLS;
const V_PITCH = (PAGE_H - 2 * MARGIN_TOP) / ROWS;

// QR code size within the label
const QR_SIZE = 0.5 * POINTS_PER_INCH;  // 36pt — leaves room for text below
const TEXT_SIZE = 4; // pt

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {

	const body = await request.json();
	const quantity = Number(body.quantity || 0);
	const prefix = (body.prefix || 'CART').trim();

	if (quantity <= 0 || quantity > 800) {
		return json({ error: 'Quantity must be between 1 and 800' }, { status: 400 });
	}

	await connectDB();

	// Generate barcodes
	const barcodes: string[] = [];
	for (let i = 0; i < quantity; i++) {
		barcodes.push(await generateBarcode(prefix, 'cartridge'));
	}

	// Create PDF
	const pdfDoc = await PDFDocument.create();
	const font = await pdfDoc.embedFont(StandardFonts.Courier);

	const sheetsNeeded = Math.ceil(quantity / LABELS_PER_SHEET);

	for (let s = 0; s < sheetsNeeded; s++) {
		const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
		const sheetBarcodes = barcodes.slice(s * LABELS_PER_SHEET, (s + 1) * LABELS_PER_SHEET);

		for (let idx = 0; idx < sheetBarcodes.length; idx++) {
			const col = idx % COLS;
			const row = Math.floor(idx / COLS);
			const barcode = sheetBarcodes[idx];

			// Label position (PDF origin is bottom-left)
			const labelX = MARGIN_LEFT + col * H_PITCH;
			const labelY = PAGE_H - MARGIN_TOP - row * V_PITCH - LABEL_H;

			// Draw label border (light gray dashed cut line)
			page.drawRectangle({
				x: labelX,
				y: labelY,
				width: LABEL_W,
				height: LABEL_H,
				borderColor: rgb(0.75, 0.75, 0.75),
				borderWidth: 0.5,
				color: undefined
			});

			// Center QR within label
			const qrX = labelX + (LABEL_W - QR_SIZE) / 2;
			const qrY = labelY + LABEL_H - QR_SIZE - 2; // 2pt from top

			// Generate QR code as PNG buffer
			const qrPng = await bwipjs.toBuffer({
				bcid: 'qrcode',
				text: barcode,
				scale: 3,
				width: 15,
				height: 15,
				includetext: false
			});

			const qrImage = await pdfDoc.embedPng(qrPng);
			page.drawImage(qrImage, {
				x: qrX,
				y: qrY,
				width: QR_SIZE,
				height: QR_SIZE
			});

			// Barcode text below QR
			const textWidth = font.widthOfTextAtSize(barcode, TEXT_SIZE);
			const textX = labelX + (LABEL_W - textWidth) / 2;
			const textY = qrY - TEXT_SIZE - 1;

			page.drawText(barcode, {
				x: textX,
				y: textY,
				size: TEXT_SIZE,
				font,
				color: rgb(0, 0, 0)
			});
		}
	}

	const pdfBytes = await pdfDoc.save();

	// Audit log
	await AuditLog.create({
		_id: generateId(),
		tableName: 'barcode_generation',
		recordId: barcodes[0] ?? '',
		action: 'INSERT',
		changedBy: locals.user?.username,
		changedAt: new Date(),
		newData: {
			quantity,
			prefix,
			sheetsNeeded,
			firstBarcode: barcodes[0],
			lastBarcode: barcodes[barcodes.length - 1]
		}
	});

	return new Response(pdfBytes, {
		status: 200,
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `inline; filename="barcodes-${prefix}-${barcodes[0]}-to-${barcodes[barcodes.length - 1]}.pdf"`
		}
	});

	} catch (err: any) {
		console.error('[generate-pdf] Error:', err);
		return json({ error: err?.message ?? 'PDF generation failed' }, { status: 500 });
	}
};
