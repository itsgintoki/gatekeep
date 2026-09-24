DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "attachments") THEN
    RAISE EXCEPTION 'Move existing Cloudinary files before applying the Supabase storage migration';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "attachments" RENAME COLUMN "cloudinary_public_id" TO "storage_path";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "resource_type";
