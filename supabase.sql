-- ============================================================
-- مجلس المحللين: إعداد Supabase كاملاً (نسخ ولصق ثم Run)
-- Supabase Dashboard ثم SQL Editor ثم New query ثم الصق ثم Run
-- الملف آمن للتشغيل أكثر من مرة، ولا يحذف بياناتك.
-- ============================================================

-- 1) الجدول: صف باسم main للحالة الحالية، وصفوف daily-YYYY-MM-DD للنسخ اليومية
create table if not exists public.council_state (
  id         text primary key,
  data       jsonb       not null,
  saved_at   timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.council_state is
  'نسخة سحابية من ذاكرة وتعلّم مجلس المحللين. الصف main هو الحالة الحالية.';

-- 2) تحديث updated_at تلقائياً عند أي تعديل
create or replace function public.council_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists council_touch on public.council_state;
create trigger council_touch
  before update on public.council_state
  for each row execute function public.council_touch();

-- 3) الأمان: لا أحد يصل للجدول إلا الخادم بمفتاح service_role
alter table public.council_state enable row level security;

drop policy if exists "no_public_access" on public.council_state;
-- لا نُنشئ أي policy مسموحة، فيُمنع anon و authenticated تماماً.
revoke all on public.council_state from anon, authenticated;
grant  all on public.council_state to service_role;

-- 4) فحص بعد التشغيل (اختياري): يجب أن ترى الجدول فارغاً أول مرة
select count(*) as rows_count from public.council_state;

-- 5) بعد أول Deploy ناجح، شغّل هذا للتأكد أن الحفظ يعمل:
-- select id,
--        saved_at,
--        updated_at,
--        pg_size_pretty(length(data::text)::bigint) as size,
--        (select array_agg(k) from jsonb_object_keys(data->'tf') k) as timeframes
-- from public.council_state
-- order by id;

-- 6) تنظيف يدوي للنسخ اليومية الأقدم من 14 يوماً (الخادم يفعل ذلك تلقائياً):
-- delete from public.council_state
-- where id like 'daily-%' and id < 'daily-' || to_char(now() - interval '14 days', 'YYYY-MM-DD');

-- 7) استرجاع يدوي من نسخة يومية إلى الحالة الحالية (عند الحاجة فقط):
-- update public.council_state
-- set data = (select data from public.council_state where id = 'daily-2026-11-20')
-- where id = 'main';
