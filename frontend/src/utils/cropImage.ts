import { Area } from "react-easy-crop";

const MAX_WIDTH = 1200;
const QUALITY = 0.82;

/**
 * Listing photos are uploaded to Supabase Storage rather than embedded in the
 * database row, so they can afford a higher resolution: the lightbox shows the
 * full image, while grids get a smaller rendition from the image optimizer.
 */
export const LISTING_MAX_WIDTH = 2000;

/**
 * Largest photo accepted from the device. The upload is the re-encoded
 * rendition (≤ 2000 px wide, well under the 5 MB bucket limit), so this only
 * guards memory: a 5 MB cap here rejected ordinary phone photos.
 */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Draws a source region onto a canvas, scaling it down to maxWidth, and encodes it. */
function encodeRegion(
  image: HTMLImageElement,
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number
): string {
  // Scale down if the source region exceeds maxWidth
  const scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
  const outputWidth = Math.round(sourceWidth * scale);
  const outputHeight = Math.round(sourceHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    outputWidth,
    outputHeight
  );

  // Use WebP when supported (all modern browsers except older Safari), fall back to JPEG
  const webpTest = canvas.toDataURL("image/webp");
  const mimeType = webpTest.startsWith("data:image/webp") ? "image/webp" : "image/jpeg";

  return canvas.toDataURL(mimeType, QUALITY);
}

/**
 * Loads a source image for canvas export. Re-editing a listing photo reads it
 * back from Storage, so the request must be a CORS one or the canvas would be
 * tainted and toDataURL would throw. Harmless for data: URLs.
 */
function loadImage(imageSrc: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image"));
    image.src = imageSrc;
  });
}

export default async function getCroppedImg(
  imageSrc: string,
  pixelCrop: Area,
  maxWidth: number = MAX_WIDTH
): Promise<string> {
  const image = await loadImage(imageSrc);
  return encodeRegion(image, pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height, maxWidth);
}

/**
 * Same downscale and encoding pipeline as getCroppedImg, but keeps the whole
 * image instead of a crop region — nothing is discarded.
 */
export async function getFullImage(
  imageSrc: string,
  maxWidth: number = MAX_WIDTH
): Promise<string> {
  const image = await loadImage(imageSrc);
  return encodeRegion(image, 0, 0, image.naturalWidth, image.naturalHeight, maxWidth);
}
