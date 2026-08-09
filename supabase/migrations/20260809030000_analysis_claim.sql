-- Make the vision pass idempotent.
--
-- Checking "is there a row yet?" before analysing is a read-then-write race: two tabs, or a
-- retry, can both pass the check and both pay OpenAI for the same listing. Instead a caller
-- CLAIMS the property by inserting a row first — the primary key makes exactly one caller win —
-- and only the winner spends money.

alter table property_analysis add column if not exists status text not null default 'done'
  check (status in ('running', 'done', 'failed'));
alter table property_analysis add column if not exists claimed_at timestamptz not null default now();
alter table property_analysis add column if not exists error text;
alter table property_analysis add column if not exists input_tokens int;
alter table property_analysis add column if not exists output_tokens int;

-- A claim is written before the result exists, so these cannot be NOT NULL.
alter table property_analysis alter column image_count drop not null;
alter table property_analysis alter column has_floorplan drop not null;
alter table property_analysis alter column model drop not null;

-- Claim the property, returning true only for the caller that actually won it. A run that died
-- mid-flight leaves a stale 'running' row; after the timeout another caller may take it over,
-- otherwise one crash would block that listing forever.
create or replace function claim_analysis(p_rightmove_id text, p_stale_after interval default '10 minutes')
returns boolean
language plpgsql
security invoker
as $$
declare
  inserted int;
begin
  insert into property_analysis (rightmove_id, status, claimed_at)
  values (p_rightmove_id, 'running', now())
  on conflict (rightmove_id) do update
    set status = 'running', claimed_at = now(), error = null
    where property_analysis.status = 'failed'
       or (property_analysis.status = 'running'
           and property_analysis.claimed_at < now() - p_stale_after);

  get diagnostics inserted = row_count;
  return inserted > 0;
end;
$$;

grant execute on function claim_analysis(text, interval) to anon;
