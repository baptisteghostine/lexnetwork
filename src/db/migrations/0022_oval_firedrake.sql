CREATE TABLE `outreach_drafts` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`group_id` integer,
	`kind` text NOT NULL,
	`to_email` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text NOT NULL,
	`interaction_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	`discarded_at` integer,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_outreach_drafts_status` ON `outreach_drafts` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_outreach_drafts_contact` ON `outreach_drafts` (`contact_id`,`status`);