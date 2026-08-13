CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`file_name` text,
	`file_sha256` text,
	`mapping_json` text,
	`cursor_before` text,
	`cursor_after` text,
	`status` text NOT NULL,
	`stats_json` text,
	`report_json` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sync_runs_kind` ON `sync_runs` (`kind`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_sync_runs_sha` ON `sync_runs` (`file_sha256`);--> statement-breakpoint
ALTER TABLE `contact_field_sources` ADD `sync_run_id` integer REFERENCES sync_runs(id);