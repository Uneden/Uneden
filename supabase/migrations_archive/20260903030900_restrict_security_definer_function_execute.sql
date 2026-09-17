-- SECURITY DEFINER functions were callable over the REST API by anyone, because
-- PostgreSQL grants EXECUTE to PUBLIC by default. Revoke from PUBLIC (which also
-- covers anon) and grant back only to the roles that genuinely need each one.

-- Trigger functions: invoked by the trigger machinery, which checks EXECUTE at
-- CREATE TRIGGER time, not at fire time. Nobody should call these directly.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_user_update() from public, anon, authenticated;
revoke execute on function public.log_message_changes() from public, anon, authenticated;
revoke execute on function public.sync_user_to_profile() from public, anon, authenticated;

-- Helpers referenced inside the chat RLS policies. Policy expressions are
-- evaluated as the querying role, so signed-in users must keep EXECUTE or
-- messaging breaks. Anonymous visitors have no business reading chat tables.
revoke execute on function public.is_chat_member(uuid, uuid) from public, anon;
grant execute on function public.is_chat_member(uuid, uuid) to authenticated, service_role;

revoke execute on function public.get_my_chat_room_ids() from public, anon;
grant execute on function public.get_my_chat_room_ids() to authenticated, service_role;

-- Called over RPC from the app (lib/chatUtils.ts) by signed-in users only.
revoke execute on function public.get_or_create_direct_chat(uuid) from public, anon;
grant execute on function public.get_or_create_direct_chat(uuid) to authenticated, service_role;
