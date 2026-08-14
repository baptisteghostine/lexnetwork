-- Rebuild interactions + contact_field_sources so their sync_run_id FKs
-- carry ON DELETE SET NULL, as schema.ts and the drizzle snapshots have
-- declared since 0002/0008 — the applied ALTERs dropped the clause
-- (defaulting to NO ACTION), so any future sync_runs pruning would fail
-- with an FK error instead of nulling the reference. SQLite bakes FK
-- behavior into table DDL, so this is the standard rebuild-copy-swap.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `interactions_new` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`kind` text NOT NULL,
	`direction` text,
	`occurred_at` integer NOT NULL,
	`title` text,
	`meta` text,
	`source` text NOT NULL,
	`source_key` text,
	`counts_for_touch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`sync_run_id` integer REFERENCES sync_runs(id) ON DELETE SET NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `interactions_new` (`id`, `contact_id`, `kind`, `direction`, `occurred_at`, `title`, `meta`, `source`, `source_key`, `counts_for_touch`, `created_at`, `sync_run_id`)
SELECT `id`, `contact_id`, `kind`, `direction`, `occurred_at`, `title`, `meta`, `source`, `source_key`, `counts_for_touch`, `created_at`, `sync_run_id` FROM `interactions`;--> statement-breakpoint
DROP TABLE `interactions`;--> statement-breakpoint
ALTER TABLE `interactions_new` RENAME TO `interactions`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_interactions_source` ON `interactions` (`contact_id`,`source`,`source_key`) WHERE source_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_interactions_contact_time` ON `interactions` (`contact_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_interactions_time` ON `interactions` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_interactions_touch` ON `interactions` (`contact_id`,`occurred_at`) WHERE counts_for_touch = 1;--> statement-breakpoint
CREATE TABLE `contact_field_sources_new` (
	`contact_id` integer NOT NULL,
	`field` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	`sync_run_id` integer REFERENCES sync_runs(id) ON DELETE SET NULL,
	PRIMARY KEY(`contact_id`, `field`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `contact_field_sources_new` (`contact_id`, `field`, `source`, `updated_at`, `sync_run_id`)
SELECT `contact_id`, `field`, `source`, `updated_at`, `sync_run_id` FROM `contact_field_sources`;--> statement-breakpoint
DROP TABLE `contact_field_sources`;--> statement-breakpoint
ALTER TABLE `contact_field_sources_new` RENAME TO `contact_field_sources`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
