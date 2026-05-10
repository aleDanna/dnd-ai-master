ALTER TABLE "characters" ADD COLUMN "downtime_activities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "hirelings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "bastion" jsonb DEFAULT 'null'::jsonb;