// SPDX-License-Identifier: AGPL-3.0-only
import {initSync, JxlImage} from '../tools/vendor/jxl-oxide/jxl_oxide_wasm.js';
import {configurePaintRasterDecoder} from '../images/paint-raster.mjs';
import {createPaintPNGCodec} from '../draw/paint-png.mjs';

const png = createPaintPNGCodec();
export const HOSTED_PAINT_PIXELS = 2048 * 1024;
const tooLarge = () => Object.assign(new Error('This painting is larger than Rapier\'s server can open.'), {code: 'paint_too_large_for_server'});
const check = signal => { if (signal?.aborted) { const error = new Error('Painting canceled'); error.name = 'AbortError'; throw error; } };
export function configureHostedPaintRaster(moduleOrBytes) {
	initSync({module: moduleOrBytes});
	configurePaintRasterDecoder(async (bytes, {signal} = {}) => {
		check(signal);
		const image = new JxlImage();
		try {
			image.forceSrgb = true; image.feedBytes(bytes);
			if (!image.tryInit() || !image.width || !image.height || image.width > 16384 || image.height > 16384 || image.width * image.height > 12000000 || image.animated) throw new Error('Invalid paint JPEG XL dimensions');
			if (image.width * image.height > HOSTED_PAINT_PIXELS) throw tooLarge();
			if (!image.loaded) throw new Error('Incomplete painting JPEG XL');
			check(signal);
			const rendered = image.render(0);
			let encoded;
			try { encoded = rendered.encodeToPng(); } finally { if (rendered.__wbg_ptr) rendered.free(); }
			let binary = '';
			for (let at = 0; at < encoded.length; at += 16384) binary += String.fromCharCode(...encoded.subarray(at, at + 16384));
			const pixels = await png.decode('data:image/png;base64,' + btoa(binary));
			check(signal);
			if (!pixels || pixels.width !== image.width || pixels.height !== image.height) throw new Error('The hosted paint decoder returned a different raster');
			return pixels;
		} finally { image.free(); }
	});
}
