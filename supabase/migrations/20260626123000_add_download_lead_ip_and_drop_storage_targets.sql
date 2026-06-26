alter table public.sidestream_download_leads
  add column if not exists ip_address inet;

alter table public.sidestream_download_leads
  drop column if exists storage_targets;

create index if not exists sidestream_download_leads_ip_idx
  on public.sidestream_download_leads (ip_address);
