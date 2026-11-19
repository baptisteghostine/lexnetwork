CREATE TABLE `email_guesses` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`email_normalized` text NOT NULL,
	`domain` text NOT NULL,
	`pattern` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_guesses_contact_email` ON `email_guesses` (`contact_id`,`email_normalized`);--> statement-breakpoint
CREATE INDEX `idx_email_guesses_domain` ON `email_guesses` (`domain`,`status`);--> statement-breakpoint
CREATE TABLE `firms` (
	`id` integer PRIMARY KEY NOT NULL,
	`company_key` text NOT NULL,
	`name` text NOT NULL,
	`tier` text,
	`tier_source` text,
	`tier_note` text,
	`email_domain` text,
	`email_pattern` text,
	`email_source` text,
	`email_basis` text,
	`email_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_firms_key` ON `firms` (`company_key`);--> statement-breakpoint
CREATE INDEX `idx_firms_tier` ON `firms` (`tier`);--> statement-breakpoint
ALTER TABLE `work_history` ADD `description` text;