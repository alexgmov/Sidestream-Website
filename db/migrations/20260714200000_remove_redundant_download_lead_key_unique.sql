-- Canonical lead identity is enforced by (email, cta_source). Keeping the
-- historical lead_key uniqueness constraint makes concurrent inserts for that
-- same identity race on the wrong constraint before the canonical upsert can
-- merge them.
alter table public.sidestream_download_leads
  drop constraint if exists sidestream_download_leads_lead_key_unique;

create index if not exists sidestream_download_leads_lead_key_idx
  on public.sidestream_download_leads (lead_key);
