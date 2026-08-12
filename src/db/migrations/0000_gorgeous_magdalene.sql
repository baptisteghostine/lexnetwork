CREATE TABLE `contact_emails` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`email` text NOT NULL,
	`email_normalized` text NOT NULL,
	`label` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_emails_contact_normalized` ON `contact_emails` (`contact_id`,`email_normalized`);--> statement-breakpoint
CREATE INDEX `idx_emails_normalized` ON `contact_emails` (`email_normalized`);--> statement-breakpoint
CREATE TABLE `contact_field_sources` (
	`contact_id` integer NOT NULL,
	`field` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`contact_id`, `field`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `contact_phones` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`phone_raw` text NOT NULL,
	`phone_e164` text,
	`label` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_phones_contact_e164` ON `contact_phones` (`contact_id`,`phone_e164`);--> statement-breakpoint
CREATE INDEX `idx_phones_e164` ON `contact_phones` (`phone_e164`) WHERE phone_e164 IS NOT NULL;--> statement-breakpoint
CREATE TABLE `contact_socials` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`platform` text NOT NULL,
	`url` text NOT NULL,
	`handle` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_socials_contact_url` ON `contact_socials` (`contact_id`,`url`);--> statement-breakpoint
CREATE INDEX `idx_socials_url` ON `contact_socials` (`url`);--> statement-breakpoint
CREATE INDEX `idx_socials_linkedin` ON `contact_socials` (`contact_id`) WHERE platform = 'linkedin';--> statement-breakpoint
CREATE TABLE `contact_tags` (
	`contact_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`contact_id`, `tag_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_contact_tags_tag` ON `contact_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY NOT NULL,
	`first_name` text,
	`last_name` text,
	`display_name` text NOT NULL,
	`photo_path` text,
	`title` text,
	`company` text,
	`location` text,
	`location_lat` real,
	`location_lng` real,
	`bio` text,
	`description_md` text,
	`birthday_month` integer,
	`birthday_day` integer,
	`birthday_year` integer,
	`starred` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`cadence_days` integer,
	`cadence_assigned_at` integer,
	`snoozed_until` integer,
	`last_interaction_at` integer,
	`next_touch_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_contacts_next_touch` ON `contacts` (`next_touch_at`) WHERE archived_at IS NULL AND cadence_days IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_contacts_birthday` ON `contacts` (`birthday_month`,`birthday_day`);--> statement-breakpoint
CREATE INDEX `idx_contacts_company` ON `contacts` (`company`);--> statement-breakpoint
CREATE INDEX `idx_contacts_created` ON `contacts` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_contacts_last_interaction` ON `contacts` (`last_interaction_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);