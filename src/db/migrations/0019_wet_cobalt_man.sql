CREATE TABLE `ai_annotations` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` integer NOT NULL,
	`payload_json` text NOT NULL,
	`model` text NOT NULL,
	`ai_call_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ai_call_id`) REFERENCES `ai_calls`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_annotations_subject` ON `ai_annotations` (`kind`,`subject_id`);