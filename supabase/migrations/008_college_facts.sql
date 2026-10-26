-- 008: official college facts, housing, and culture for the Compare page and college pages. Idempotent.
-- Shape: { as_of, stats:{...}, net_price_by_income:{...}, business:{...}, housing:{...}, campus:{...}, sources:[{label,url,year}] }
alter table public.colleges add column if not exists facts jsonb;
