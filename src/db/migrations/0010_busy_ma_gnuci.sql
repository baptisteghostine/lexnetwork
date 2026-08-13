CREATE TABLE `contact_relationships` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_a_id` integer NOT NULL,
	`contact_b_id` integer NOT NULL,
	`label` text NOT NULL,
	`directed` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contact_a_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_b_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_relationship` ON `contact_relationships` (`contact_a_id`,`contact_b_id`,`label`);--> statement-breakpoint
CREATE INDEX `idx_relationships_b` ON `contact_relationships` (`contact_b_id`);--> statement-breakpoint
CREATE TABLE `duplicate_candidates` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_a_id` integer NOT NULL,
	`contact_b_id` integer NOT NULL,
	`score` real NOT NULL,
	`reasons_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`contact_a_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_b_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_duplicate_pair` ON `duplicate_candidates` (`contact_a_id`,`contact_b_id`);--> statement-breakpoint
CREATE INDEX `idx_duplicates_status` ON `duplicate_candidates` (`status`,`score`);--> statement-breakpoint
CREATE TABLE `merge_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`winner_contact_id` integer NOT NULL,
	`loser_contact_id` integer NOT NULL,
	`loser_snapshot_json` text NOT NULL,
	`repointed_json` text NOT NULL,
	`field_decisions_json` text NOT NULL,
	`merged_at` integer NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_merge_log_time` ON `merge_log` (`merged_at`);