CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text,
	`dedupe_key` text,
	`run_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_pending` ON `jobs` (`run_at`) WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `uq_jobs_dedupe` ON `jobs` (`dedupe_key`) WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer,
	`title` text NOT NULL,
	`body` text,
	`due_at` integer NOT NULL,
	`rrule` text,
	`series_id` integer,
	`fired_at` integer,
	`completed_at` integer,
	`snoozed_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_reminders_due` ON `reminders` (`due_at`) WHERE completed_at IS NULL AND rrule IS NULL;--> statement-breakpoint
CREATE INDEX `idx_reminders_contact` ON `reminders` (`contact_id`);