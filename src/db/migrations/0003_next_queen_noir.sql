DROP INDEX `idx_contacts_birthday`;--> statement-breakpoint
CREATE INDEX `idx_contacts_starred` ON `contacts` (`starred`) WHERE starred = 1;--> statement-breakpoint
CREATE INDEX `idx_contacts_birthday` ON `contacts` (`birthday_month`,`birthday_day`) WHERE archived_at IS NULL;