import type { Area } from "react-easy-crop";
import { supabase } from "@/lib/supabaseClient";

const BUCKET = "listing-images";

/**
 * Marks the untouched version of a photo. Cropping only decides how a listing is
 * framed on cards and in the hero: the full photo is uploaded alongside it so the
 * lightbox can always show what the poster actually shot.
 */
const FULL_SUFFIX = "__full";

/**
 * The framed file also carries the crop rectangle in its name, so re-editing a
 * photo can reopen the cropper exactly where the poster left it. Percentages
 * rather than pixels: re-editing starts from the downscaled full file, whose
 * pixel dimensions differ from the original upload.
 */
const CROP_RE = /__c(\d+)-(\d+)-(\d+)-(\d+)\.(?:webp|jpg|jpeg|png)$/i;
const SUFFIX_RE = /(?:__full|__c\d+-\d+-\d+-\d+)?\.(webp|jpg|jpeg|png)$/i;

/** Percentages are stored as hundredths so the file name stays digits-only. */
const SCALE = 100;

/** Decodes a data: URL produced by the crop pipeline into a Blob ready to upload. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] ?? "image/webp";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function cropTag(crop: Area): string {
  const part = (value: number) => Math.max(0, Math.round(value * SCALE));
  return `__c${part(crop.x)}-${part(crop.y)}-${part(crop.width)}-${part(crop.height)}`;
}

async function upload(path: string, blob: Blob): Promise<string> {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Uploads a listing photo and returns the URL to display on cards. `framed` is
 * what the poster cropped, `full` the whole photo, `crop` the rectangle used —
 * expressed in percentages of the source image.
 *
 * Files are never deleted when removed from the form: a listing being edited
 * still points at its stored file until the save actually goes through, so
 * deleting early would break a live listing if the edit is cancelled.
 */
export async function uploadListingImage(
  framed: string,
  full: string,
  crop: Area
): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const framedBlob = dataUrlToBlob(framed);
  const ext = framedBlob.type === "image/webp" ? "webp" : "jpg";
  // RLS requires the first folder segment to match the uploader's uid.
  const base = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await upload(`${base}${FULL_SUFFIX}.${ext}`, dataUrlToBlob(full));
  return upload(`${base}${cropTag(crop)}.${ext}`, framedBlob);
}

/**
 * Uploads a cropped avatar or portfolio photo (data: URL from the crop
 * pipeline) and returns its public URL. These used to be saved as base64 in the
 * users row, which was then sent with every notification poll, conversation
 * list and listing: most of the project's database egress.
 */
export async function uploadUserImage(dataUrl: string, kind: "avatar" | "portfolio"): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const blob = dataUrlToBlob(dataUrl);
  const ext = blob.type === "image/webp" ? "webp" : "jpg";
  // RLS requires the first folder segment to match the uploader's uid.
  return upload(`${userId}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`, blob);
}

/**
 * Maps a card image URL to its uncropped companion. Returns the URL unchanged for
 * anything we did not upload this way (legacy base64 listings, or photos stored
 * before full versions were kept) — callers should fall back to it if it 404s.
 */
export function fullListingImageUrl(url: string): string {
  if (!url.includes(`/${BUCKET}/`)) return url;
  if (!SUFFIX_RE.test(url)) return url;
  return url.replace(SUFFIX_RE, `${FULL_SUFFIX}.$1`);
}

/**
 * Whether a URL actually resolves to an image. Photos uploaded before full
 * versions were kept have no companion file, and the storage API answers 400 —
 * callers must fall back rather than hand a dead URL to the cropper.
 */
export function imageIsReachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(true);
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
}

/** The crop rectangle a photo was framed with, or null for photos stored without one. */
export function listingCropArea(url: string): Area | null {
  const match = url.match(CROP_RE);
  if (!match) return null;
  return {
    x: Number(match[1]) / SCALE,
    y: Number(match[2]) / SCALE,
    width: Number(match[3]) / SCALE,
    height: Number(match[4]) / SCALE,
  };
}
