/**
 * Barcode-presence detector for auto-classifying a capture's camera view.
 *
 * The cartridge barcode is visible ONLY in TOP photos, so barcode presence is a
 * proxy for the view: a barcode ⇒ top, none ⇒ bottom. We decode with zxing-wasm
 * purely to answer "is a barcode present?" — the decoded VALUE is never read,
 * stored, or returned. If the label ever moves to the other face, flip the two
 * constants below.
 *
 * This only runs when the operator did not set the view toggle manually; the
 * manual toggle always wins. Detection must NEVER block or fail a capture, so
 * every failure path (bad image, wasm load error, slow decode) resolves to
 * `null` = "detection unavailable, leave the view untagged".
 */
import sharp from 'sharp';
import { readBarcodes } from 'zxing-wasm/reader';

// The cartridge barcode faces the top camera. If the label ever moves to the
// other face, flip these two.
export const BARCODE_VIEW = 'top';
export const NO_BARCODE_VIEW = 'bottom';

// Decoding is best-effort telemetry, not part of the capture contract — cap it
// so a pathological image can never stall the request.
const DETECT_TIMEOUT_MS = 3000;

// Downscale wide enough for zxing to resolve a QR/1D symbol without paying to
// decode a full-res capture.
const DETECT_WIDTH = 1200;

async function detect(buffer: Buffer): Promise<boolean> {
	// rotate() honours EXIF orientation; ensureAlpha() forces RGBA so the raw
	// buffer matches the ImageData layout zxing expects (4 bytes/pixel).
	const { data, info } = await sharp(buffer)
		.rotate()
		.resize({ width: DETECT_WIDTH, withoutEnlargement: true })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });

	// Shaped like a DOM ImageData (what readBarcodes accepts). The array-copy
	// constructor (vs. the buffer view) gives a plain ArrayBuffer-backed
	// Uint8ClampedArray, which is what the ImageData type requires. colorSpace is
	// required by the type but unused by zxing's raw-pixel decode.
	const imageData = {
		data: new Uint8ClampedArray(data),
		width: info.width,
		height: info.height,
		colorSpace: 'srgb' as const
	};

	// formats: [] = search all supported symbologies (QR + 1D). tryHarder trades
	// a little speed for recall — worth it since a missed barcode misclassifies.
	const barcodes = await readBarcodes(imageData, { formats: [], tryHarder: true });
	return barcodes.length > 0;
}

/**
 * @returns `true`  — a barcode was found (⇒ {@link BARCODE_VIEW})
 *          `false` — no barcode (⇒ {@link NO_BARCODE_VIEW})
 *          `null`  — detection unavailable (error or timeout); caller leaves the
 *                    view untagged. Never throws.
 */
export async function detectBarcodePresence(buffer: Buffer): Promise<boolean | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), DETECT_TIMEOUT_MS);
		});
		return await Promise.race([detect(buffer), timeout]);
	} catch (err) {
		console.error('[barcode-detect] detection failed:', err instanceof Error ? err.message : err);
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
