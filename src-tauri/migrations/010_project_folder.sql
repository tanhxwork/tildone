-- A project can point at its source folder on disk, from which Tildone discovers
-- an icon (first match of a priority list). Semantics of folder_path:
--   NULL          -> auto-guess ~/projects/<name>, then discover
--   '' (empty)    -> icon explicitly disabled; fall back to the colour dot
--   '<path>'      -> use this folder, then discover
ALTER TABLE projects ADD COLUMN folder_path TEXT;
