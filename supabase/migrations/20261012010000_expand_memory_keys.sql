-- Expand the typed memory catalog without changing existing rows.
alter table public.memories drop constraint if exists memories_key_check;
alter table public.memories add constraint memories_key_check check (key in (
  'report_recipients', 'cc', 'report_format',
  'writing_tone', 'timezone', 'project_context', 'personal_preference'
));
