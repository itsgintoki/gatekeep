import { v2 as cloudinary } from "cloudinary";

export function storageConfigured(): boolean {
  return [process.env.CLOUDINARY_CLOUD_NAME, process.env.CLOUDINARY_API_KEY, process.env.CLOUDINARY_API_SECRET]
    .every((value) => Boolean(value && !value.startsWith("your_")));
}

function requireStorage(): void {
  if (!storageConfigured()) throw Object.assign(new Error("Uploads are unavailable until Cloudinary storage is configured."), { status: 503 });
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export interface UploadResult {
  url: string;
  publicId: string;
  resourceType: string;
}

export function uploadBuffer(
  buffer: Buffer,
  folder: string,
  mimeType = "image/png"
): Promise<UploadResult> {
  requireStorage();
  const resourceType = mimeType.startsWith("video/") ? "video" : mimeType.includes("word") ? "raw" : "image";
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { folder, resource_type: resourceType },
        (err, result) => {
          if (err || !result) return reject(err ?? new Error("Upload failed"));
          resolve({ url: result.secure_url, publicId: result.public_id, resourceType: result.resource_type });
        }
      )
      .end(buffer);
  });
}

export async function deleteAsset(publicId: string, resourceType = "image"): Promise<void> {
  requireStorage();
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}

export default cloudinary;
