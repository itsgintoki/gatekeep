import { v2 as cloudinary } from "cloudinary";

if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  throw new Error(
    "Missing Cloudinary env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET"
  );
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export interface UploadResult {
  url: string;
  publicId: string;
}

export function uploadBuffer(
  buffer: Buffer,
  folder: string
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { folder, resource_type: "auto" },
        (err, result) => {
          if (err || !result) return reject(err ?? new Error("Upload failed"));
          resolve({ url: result.secure_url, publicId: result.public_id });
        }
      )
      .end(buffer);
  });
}

export async function deleteAsset(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
}

export default cloudinary;
