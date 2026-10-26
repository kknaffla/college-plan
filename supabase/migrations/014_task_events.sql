-- 014: mark a task as an event (concert, meeting, game) rather than a to-do. Idempotent.
-- Events drop off after their date and never count as overdue or toward progress.
alter table public.tasks add column if not exists is_event boolean not null default false;
