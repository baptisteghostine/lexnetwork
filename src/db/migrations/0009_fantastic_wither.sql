CREATE TABLE `calendar_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`account_id` integer NOT NULL,
	`summary` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`all_day` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`my_response` text,
	`attendees` text,
	`html_link` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `integration_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_calendar_event` ON `calendar_events` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_calendar_events_start` ON `calendar_events` (`starts_at`);--> statement-breakpoint
CREATE TABLE `integration_accounts` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`account_email` text NOT NULL,
	`scopes` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` integer,
	`gmail_history_id` text,
	`gmail_backfill_done` integer DEFAULT false NOT NULL,
	`calendar_sync_token` text,
	`people_sync_token` text,
	`my_addresses` text,
	`linkedin_domains` text,
	`linkedin_snapshot_at` integer,
	`status` text NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_integration_provider` ON `integration_accounts` (`provider`);