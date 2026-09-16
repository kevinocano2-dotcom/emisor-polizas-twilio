-- COTIZADOR SEGUROS - SUPABASE
-- Puedes ejecutar este archivo otra vez aunque ya exista la tabla leads.
create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text,
  status text default 'nuevo',
  name text,
  whatsapp text,
  vehicle_origin text,
  vehicle_type text,
  vehicle_year integer,
  vehicle_make text,
  vehicle_model text,
  vehicle_version text,
  postal_code text,
  colony text,
  age integer,
  sex text,
  fixed_email text,
  aarco_quote_id bigint,
  axa_aarco_price numeric,
  axa_estimated_price numeric,
  axa_actual_price numeric,
  conversion_version text,
  ana_third_party_price numeric,
  all_quotes jsonb,
  customer_choice text,
  source_params jsonb,
  last_error text,
  last_event text
);

create index if not exists leads_created_at_idx on public.leads(created_at desc);
create index if not exists leads_whatsapp_idx on public.leads(whatsapp);
create index if not exists leads_status_idx on public.leads(status);
alter table public.leads enable row level security;

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;


-- V4: seguimiento comercial
-- Estos ALTER funcionan aunque la tabla leads ya exista.
alter table public.leads add column if not exists comments text;

alter table public.leads add column if not exists msg_axa_sent boolean not null default false;
alter table public.leads add column if not exists msg_axa_sent_at timestamptz;

alter table public.leads add column if not exists msg_ana_sent boolean not null default false;
alter table public.leads add column if not exists msg_ana_sent_at timestamptz;

alter table public.leads add column if not exists msg_other_options_sent boolean not null default false;
alter table public.leads add column if not exists msg_other_options_sent_at timestamptz;

alter table public.leads add column if not exists msg_followup_sent boolean not null default false;
alter table public.leads add column if not exists msg_followup_sent_at timestamptz;


-- V5: captación temprana y vehículo escrito libremente
alter table public.leads add column if not exists session_id text;
alter table public.leads add column if not exists vehicle_notes text;
create index if not exists leads_session_id_idx on public.leads(session_id);


-- V5: embudo de abandono
create table if not exists public.visitor_sessions (
  session_id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source_params jsonb,
  last_step text,
  vehicle_origin text,
  vehicle_type text,
  vehicle_year integer,
  vehicle_make text,
  vehicle_model text,
  vehicle_version text,
  vehicle_notes text,
  age integer,
  sex text,
  whatsapp text,
  quote_started boolean not null default false,
  axa_shown boolean not null default false,
  whatsapp_clicked boolean not null default false,
  axa_estimated_price numeric,
  aarco_quote_id bigint,
  lead_id uuid
);

create index if not exists visitor_sessions_created_at_idx on public.visitor_sessions(created_at desc);
create index if not exists visitor_sessions_last_step_idx on public.visitor_sessions(last_step);
create index if not exists visitor_sessions_whatsapp_idx on public.visitor_sessions(whatsapp);

create table if not exists public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  event_name text not null,
  event_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists funnel_events_created_at_idx on public.funnel_events(created_at desc);
create index if not exists funnel_events_session_idx on public.funnel_events(session_id);
create index if not exists funnel_events_name_idx on public.funnel_events(event_name);

alter table public.visitor_sessions enable row level security;
alter table public.funnel_events enable row level security;
