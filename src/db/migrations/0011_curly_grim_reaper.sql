CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`response` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_calls_feature` ON `ai_calls` (`feature`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_suggestions` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`contact_id` integer NOT NULL,
	`payload_json` text NOT NULL,
	`ai_call_id` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ai_call_id`) REFERENCES `ai_calls`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_ai_suggestions_status` ON `ai_suggestions` (`status`,`created_at`);