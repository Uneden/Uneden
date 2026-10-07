-- Columns sized smaller than what the app writes into them. Each mismatch made
-- the write fail with "value too long" (22001), surfaced to users as a generic
-- 500. varchar → text is binary-compatible: no table rewrite.

-- services.subcategory stores the listing tags joined with " · " (see
-- normalizeListingTags in backend/src/utils/listingTags.js): up to 5 tags of
-- 80 chars, i.e. ~412 chars. With varchar(100), publishing or editing a
-- listing failed with "Server error while creating service" as soon as the
-- selected tags exceeded 100 chars combined.
ALTER TABLE public.services ALTER COLUMN subcategory TYPE text;

-- public.users.full_name / company_name are text, but sync_user_to_profile
-- (AFTER UPDATE on users, no exception handler) copies them here: a name over
-- 255 chars made every profile update fail.
ALTER TABLE public.profiles ALTER COLUMN full_name TYPE text;
ALTER TABLE public.profiles ALTER COLUMN company_name TYPE text;
