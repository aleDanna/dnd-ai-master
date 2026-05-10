ALTER TABLE "characters" ADD COLUMN "template_id" uuid;--> statement-breakpoint
CREATE INDEX "characters_template_idx" ON "characters" USING btree ("template_id");