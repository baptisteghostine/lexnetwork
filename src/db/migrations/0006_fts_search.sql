-- FTS5 search layer (hand-written; SCHEMA.md "Search / FTS5 plan").
-- Trigram FTS over contact identity fields => substring + typo-tolerant
-- matching; word-based FTS over note bodies. External-content tables stay
-- in sync via triggers and rebuild from their source of truth.
CREATE VIRTUAL TABLE `contacts_fts` USING fts5(
  display_name, company, title, location, bio,
  content='contacts', content_rowid='id',
  tokenize='trigram'
);--> statement-breakpoint
CREATE VIRTUAL TABLE `notes_fts` USING fts5(
  body_md,
  content='notes', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `contacts_fts_ai` AFTER INSERT ON `contacts` BEGIN
  INSERT INTO contacts_fts(rowid, display_name, company, title, location, bio)
  VALUES (new.id, new.display_name, new.company, new.title, new.location, new.bio);
END;--> statement-breakpoint
CREATE TRIGGER `contacts_fts_ad` AFTER DELETE ON `contacts` BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, display_name, company, title, location, bio)
  VALUES ('delete', old.id, old.display_name, old.company, old.title, old.location, old.bio);
END;--> statement-breakpoint
CREATE TRIGGER `contacts_fts_au` AFTER UPDATE ON `contacts` BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, display_name, company, title, location, bio)
  VALUES ('delete', old.id, old.display_name, old.company, old.title, old.location, old.bio);
  INSERT INTO contacts_fts(rowid, display_name, company, title, location, bio)
  VALUES (new.id, new.display_name, new.company, new.title, new.location, new.bio);
END;--> statement-breakpoint
CREATE TRIGGER `notes_fts_ai` AFTER INSERT ON `notes` BEGIN
  INSERT INTO notes_fts(rowid, body_md) VALUES (new.id, new.body_md);
END;--> statement-breakpoint
CREATE TRIGGER `notes_fts_ad` AFTER DELETE ON `notes` BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body_md) VALUES ('delete', old.id, old.body_md);
END;--> statement-breakpoint
CREATE TRIGGER `notes_fts_au` AFTER UPDATE ON `notes` BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body_md) VALUES ('delete', old.id, old.body_md);
  INSERT INTO notes_fts(rowid, body_md) VALUES (new.id, new.body_md);
END;--> statement-breakpoint
-- Backfill existing rows.
INSERT INTO contacts_fts(rowid, display_name, company, title, location, bio)
SELECT id, display_name, company, title, location, bio FROM contacts;--> statement-breakpoint
INSERT INTO notes_fts(rowid, body_md) SELECT id, body_md FROM notes;
