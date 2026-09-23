ALTER TABLE "attachments" ADD COLUMN "original_name" text DEFAULT 'Attachment' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "resource_type" varchar(10) DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "is_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_name" varchar(255) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_name" varchar(255) DEFAULT '' NOT NULL;