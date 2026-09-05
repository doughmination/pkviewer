-- A badge for the people who build PluralKit.
--
-- Seeded as a migration rather than added through the admin panel so it ships
-- as a default alongside the original six, and so a fresh deployment has it
-- without anyone remembering to create it. New badge types beyond this one are
-- an admin action and need no migration — the catalogue is data.
--
-- The wording carries some weight here. pkviewer is a third-party project and
-- says so on every public page; a badge reading "PK Dev" could otherwise be
-- taken as PluralKit endorsing pkviewer, which is the one impression the whole
-- site is careful not to give. So the description says what the badge means
-- about the PERSON and states the lack of affiliation outright, and it is the
-- description that /badges shows and that a badge's tooltip carries.
--
-- The consent model covers the rest: a PluralKit developer is offered this and
-- decides whether it appears, exactly like anyone else. Nobody is labelled a
-- representative of their project without agreeing to it.
--
-- `green` is its own tone rather than Contributor's blue: they are adjacent
-- ideas — both are people who write code — and adjacent ideas are the ones
-- worth telling apart at a glance.

INSERT INTO badges (id, label, description, icon, tone, sort_order, created_at) VALUES
  ('pk-dev', 'PK Dev',
   'Works on PluralKit itself. pkviewer is an independent project and is not affiliated with or endorsed by PluralKit.',
   'gem', 'green', 15, 0)
ON CONFLICT (id) DO NOTHING;
