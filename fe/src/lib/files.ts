// Helpers to turn a picked File into the base64 attachment shape the assistant
// API expects ({ name, mime, data }). Images are downscaled first to keep the
// upload light — the server still OCRs the reduced version fine.
import type { Attachment } from "../api/assistant";

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      // strip the "data:<mime>;base64," prefix — backend wants raw base64.
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

// Downscale an image to at most `maxEdge` on its longest side, re-encoded as JPEG.
// Falls back to the original bytes if anything goes wrong (e.g. SVG, decode error).
async function downscaleImage(
  file: File,
  maxEdge = 1600,
  quality = 0.85,
): Promise<{ mime: string; data: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return { mime: file.type, data: await toBase64(file) };
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { mime: file.type, data: await toBase64(file) };
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) =>
      canvas.toBlob(r, "image/jpeg", quality),
    );
    if (!blob) return { mime: file.type, data: await toBase64(file) };
    return { mime: "image/jpeg", data: await toBase64(blob) };
  } catch {
    return { mime: file.type, data: await toBase64(file) };
  }
}

export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.type.startsWith("image/")) {
    const { mime, data } = await downscaleImage(file);
    return { name: file.name, mime, data };
  }
  return {
    name: file.name,
    mime: file.type || "application/octet-stream",
    data: await toBase64(file),
  };
}
