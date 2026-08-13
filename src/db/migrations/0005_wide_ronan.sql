CREATE TABLE `custom_field_values` (
	`id` integer PRIMARY KEY NOT NULL,
	`custom_field_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`value_text` text,
	`value_number` real,
	`value_date` integer,
	`value_json` text,
	FOREIGN KEY (`custom_field_id`) REFERENCES `custom_fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cfv_field_contact` ON `custom_field_values` (`custom_field_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `idx_cfv_field_number` ON `custom_field_values` (`custom_field_id`,`value_number`);--> statement-breakpoint
CREATE INDEX `idx_cfv_field_date` ON `custom_field_values` (`custom_field_id`,`value_date`);--> statement-breakpoint
CREATE INDEX `idx_cfv_field_text` ON `custom_field_values` (`custom_field_id`,`value_text`);--> statement-breakpoint
CREATE TABLE `custom_fields` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`options` text,
	`sort_order` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_fields_name_unique` ON `custom_fields` (`name`);--> statement-breakpoint
CREATE TABLE `education` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`school` text NOT NULL,
	`degree` text,
	`field` text,
	`start_year` integer,
	`end_year` integer,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_education_school` ON `education` (`school`);--> statement-breakpoint
CREATE TABLE `views` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`filter_json` text NOT NULL,
	`sort_json` text,
	`pinned` integer DEFAULT false NOT NULL,
	`sort_order` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_history` (
	`id` integer PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`company` text NOT NULL,
	`company_normalized` text NOT NULL,
	`title` text,
	`start_date` text,
	`end_date` text,
	`is_current` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_work_company` ON `work_history` (`company_normalized`);