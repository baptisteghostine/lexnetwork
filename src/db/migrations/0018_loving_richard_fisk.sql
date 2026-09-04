CREATE TABLE `contact_suggestions` (
	`id` integer PRIMARY KEY NOT NULL,
	`email_normalized` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`source` text NOT NULL,
	`outbound_count` integer DEFAULT 0 NOT NULL,
	`inbound_count` integer DEFAULT 0 NOT NULL,
	`meeting_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_title` text,
	`recent_json` text,
	`dismissed_at` integer,
	`contact_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_suggestions_email` ON `contact_suggestions` (`email_normalized`);--> statement-breakpoint
CREATE INDEX `idx_suggestions_open` ON `contact_suggestions` (`last_seen_at`) WHERE dismissed_at IS NULL AND contact_id IS NULL;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `prep_json` text;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `prepped_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `resurfaced_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `resurface_dismissed_at` integer;