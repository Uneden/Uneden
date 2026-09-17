ALTER TABLE public.chat_room_member ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ;
