-- 0001_conversations_log_fields.sql
-- Wire up the conversations table as the persistent chat log and bring its
-- columns up to the company standard. Run once in the Supabase SQL editor.
--
-- Context: the conversations table already existed (id/chat_id/role/content/
-- intent/created_at) but nothing wrote to it. The CS bot now logs one row per
-- inbound/outbound message. These columns add the standard metadata.
--
-- Safe to run before or after deploying the bot: logConversation() tolerates
-- the missing columns (falls back to the base payload) until this runs.

-- 1) Standard metadata columns (0 existing rows, so defaults are harmless).
alter table conversations
  add column if not exists platform text default 'telegram',
  add column if not exists sender_name text,
  add column if not exists message_type text default 'text',
  add column if not exists ai_model_used text;

-- 2) Relax the legacy intent CHECK constraint.
-- The table shipped with conversations_intent_check, which only allowed a fixed
-- value set and rejected the bot's real classifications (e.g. WORKORDER_READY).
-- intent is free-form classification metadata — drop the constraint so every
-- value is preserved. (Until this runs, the bot logs such rows with intent=null.)
alter table conversations
  drop constraint if exists conversations_intent_check;
