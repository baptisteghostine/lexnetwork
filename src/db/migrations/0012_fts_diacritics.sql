-- Rebuild contacts_fts with diacritic folding (hand-written, like 0006).
-- The trigram index stored "björn" while the query side strips diacritics
-- to "bjorn" — accented names were unfindable. `remove_diacritics 1` folds
-- at index time so both sides agree; notes_fts already folds (unicode61
-- remove_diacritics 2) and is untouched.
DROP TRIGGER IF EXISTS `contacts_fts_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `contacts_fts_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `contacts_fts_au`;--> statement-breakpoint
DROP TABLE IF EXISTS `contacts_fts`;--> statement-breakpoint
CREATE VIRTUAL TABLE `contacts_fts` USING fts5(
  display_name, company, title, location, bio,
  content='contacts', content_rowid='id',
  tokenize='trigram remove_diacritics 1'
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
INSERT INTO contacts_fts(rowid, display_name, company, title, location, bio)
SELECT id, display_name, company, title, location, bio FROM contacts;
