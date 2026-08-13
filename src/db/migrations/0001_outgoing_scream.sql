CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY NOT NULL,
	`note_id` integer NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_note` ON `attachments` (`note_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `contact_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_group_members_contact` ON `group_members` (`contact_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`emoji` text,
	`parent_id` integer,
	`sort_order` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_groups_parent_name` ON `groups` (`parent_id`,`name`) WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_groups_root_name` ON `groups` (`name`) WHERE parent_id IS NULL;--> statement-breakpoint
CREATE TABLE `interactions` (
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
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_interactions_source` ON `interactions` (`contact_id`,`source`,`source_key`) WHERE source_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_interactions_contact_time` ON `interactions` (`contact_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_interactions_time` ON `interactions` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_interactions_touch` ON `interactions` (`contact_id`,`occurred_at`) WHERE counts_for_touch = 1;--> statement-breakpoint
CREATE TABLE `note_mentions` (
	`id` integer PRIMARY KEY NOT NULL,
	`note_id` integer NOT NULL,
	`contact_id` integer,
	`group_id` integer,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_mentions_note_contact` ON `note_mentions` (`note_id`,`contact_id`) WHERE contact_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_mentions_note_group` ON `note_mentions` (`note_id`,`group_id`) WHERE group_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_mentions_contact` ON `note_mentions` (`contact_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer,
	`body_md` text DEFAULT '' NOT NULL,
	`summary_ai` text,
	`counts_for_touch` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notes_contact` ON `notes` (`contact_id`,`created_at`);