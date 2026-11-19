CREATE TABLE `whatsapp_links` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`wa_id` text NOT NULL,
	`saved_name` text NOT NULL,
	`sync_enabled` integer DEFAULT false NOT NULL,
	`sync_from` integer,
	`collector_covered_from` integer,
	`last_synced_at` integer,
	`summary_md` text,
	`summary_covers_through` integer,
	`summary_updated_at` integer,
	`summary_prev_md` text,
	`summary_prev_covers_through` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_whatsapp_links_contact` ON `whatsapp_links` (`contact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_whatsapp_links_wa_id` ON `whatsapp_links` (`wa_id`);--> statement-breakpoint
CREATE TABLE `whatsapp_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`link_id` integer NOT NULL,
	`message_key` text NOT NULL,
	`direction` text NOT NULL,
	`sent_at` integer NOT NULL,
	`kind` text NOT NULL,
	`body` text,
	`source` text NOT NULL,
	`purge_after` integer,
	`body_purged_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `whatsapp_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_whatsapp_messages_key` ON `whatsapp_messages` (`link_id`,`message_key`);--> statement-breakpoint
CREATE INDEX `idx_whatsapp_messages_time` ON `whatsapp_messages` (`link_id`,`sent_at`);