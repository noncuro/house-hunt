-- Furnish type and listing history on the property row.
--
-- Both were shown in the panel but never stored, so the shortlist card couldn't show them and
-- the two views disagreed about what a place is. Anything the panel states about a property
-- belongs here, or the shortlist is a different tool looking at the same flats.
alter table property add column if not exists furnish_type text;
alter table property add column if not exists listing_update text;
