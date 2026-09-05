-- Composition configuration.
--
-- Stored alongside theme tokens but kept a SEPARATE column, because it is a
-- separate vocabulary: composition changes what appears and how it is arranged,
-- theme changes how it looks. Merging them into one blob would be the first
-- step towards the two becoming one confused thing (T1).

ALTER TABLE themes ADD COLUMN composition TEXT NOT NULL DEFAULT '{}';
