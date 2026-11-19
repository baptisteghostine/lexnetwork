CREATE TABLE `agent_calls` (
	`id` integer PRIMARY KEY NOT NULL,
	`grant_id` integer,
	`tool` text NOT NULL,
	`args_json` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`summary` text,
	`contact_id` integer,
	`writes_json` text,
	`idempotency_key` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`undone_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `agent_grants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_agent_calls_time` ON `agent_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_calls_contact` ON `agent_calls` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_calls_writes` ON `agent_calls` (`created_at`) WHERE writes_json IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_calls_idempotency` ON `agent_calls` (`tool`,`idempotency_key`) WHERE idempotency_key IS NOT NULL AND status = 'success';--> statement-breakpoint
CREATE TABLE `agent_grants` (
	`id` integer PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text,
	`scope` text NOT NULL,
	`resource` text NOT NULL,
	`code_hash` text,
	`code_expires_at` integer,
	`code_challenge` text,
	`redirect_uri` text,
	`access_token_hash` text,
	`access_expires_at` integer,
	`refresh_token_hash` text,
	`refresh_expires_at` integer,
	`previous_refresh_hash` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_grants_code` ON `agent_grants` (`code_hash`) WHERE code_hash IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_grants_access` ON `agent_grants` (`access_token_hash`) WHERE access_token_hash IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_grants_refresh` ON `agent_grants` (`refresh_token_hash`) WHERE refresh_token_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_grants_previous_refresh` ON `agent_grants` (`previous_refresh_hash`);