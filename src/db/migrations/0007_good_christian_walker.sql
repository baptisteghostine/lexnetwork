CREATE TABLE `contact_changes` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`source` text NOT NULL,
	`sync_run_id` integer,
	`detected_at` integer NOT NULL,
	`dismissed_at` integer,
	`acted_at` integer,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_changes_open` ON `contact_changes` (`detected_at`) WHERE dismissed_at IS NULL AND acted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_changes_contact` ON `contact_changes` (`contact_id`,`detected_at`);