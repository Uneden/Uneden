-- ============================================================================
-- Baseline: full production schema as of 2026-09-17.
--
-- Uneden ran without tracked migrations until this point. The 36 migrations
-- applied to production between 2026-03-04 and 2026-09-03 are archived in
-- supabase/migrations_archive/ for reference; their effects are included here.
-- Everything below `public` schema dump was added by hand because
-- `supabase db dump` only covers user schemas.
-- ============================================================================




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."check_edit_time_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- ✅ CORRECTION : Vérifier si edited_at a changé
  IF NEW.edited_at IS NOT NULL AND OLD.edited_at IS NULL THEN
    -- Si le message a plus de 15 minutes
    IF NEW.created_at < NOW() - INTERVAL '15 minutes' THEN
      RAISE EXCEPTION 'Cannot edit messages older than 15 minutes';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."check_edit_time_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_message_rate_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  message_count INT;
BEGIN
  SELECT COUNT(*) INTO message_count
  FROM messages
  WHERE user_id = NEW.user_id
    AND created_at > NOW() - INTERVAL '1 minute';
  
  IF message_count >= 10 THEN
    RAISE EXCEPTION 'Rate limit exceeded: Maximum 10 messages per minute';
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."check_message_rate_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_chat_room_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT chat_room_id FROM chat_room_member WHERE user_id = auth.uid();
$$;


ALTER FUNCTION "public"."get_my_chat_room_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_direct_chat"("other_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_current_user UUID := auth.uid();
  v_room_id      UUID;
BEGIN
  -- Look for an existing direct (non-group) chat shared by both users
  SELECT crm1.chat_room_id INTO v_room_id
  FROM chat_room_member crm1
  JOIN chat_room_member crm2
    ON crm1.chat_room_id = crm2.chat_room_id
  JOIN chat_room cr
    ON cr.id = crm1.chat_room_id
  WHERE crm1.user_id = v_current_user
    AND crm2.user_id = other_user_id
    AND cr.is_group = FALSE
  LIMIT 1;

  IF v_room_id IS NOT NULL THEN
    RETURN v_room_id;
  END IF;

  -- Create a new direct chat room
  INSERT INTO chat_room (is_group) VALUES (FALSE) RETURNING id INTO v_room_id;

  -- Add both members
  INSERT INTO chat_room_member (chat_room_id, user_id)
  VALUES (v_room_id, v_current_user), (v_room_id, other_user_id)
  ON CONFLICT DO NOTHING;

  RETURN v_room_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_direct_chat"("other_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (
    id, email, full_name, avatar_url, avatar, account_type,
    company_name, bio, profession, industry, city, province,
    phone, postal_code, team_size
  )
  VALUES (
    NEW.id, NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.raw_user_meta_data->>'avatar',
    COALESCE(NEW.raw_user_meta_data->>'account_type', 'person'),
    NEW.raw_user_meta_data->>'company_name',
    NEW.raw_user_meta_data->>'bio',
    NEW.raw_user_meta_data->>'profession',
    NEW.raw_user_meta_data->>'industry',
    NEW.raw_user_meta_data->>'city',
    NEW.raw_user_meta_data->>'province',
    NEW.raw_user_meta_data->>'phone',
    NEW.raw_user_meta_data->>'postal_code',
    CASE
      WHEN NEW.raw_user_meta_data->>'team_size' IS NOT NULL
      THEN (NEW.raw_user_meta_data->>'team_size')::integer
      ELSE NULL
    END
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    avatar_url = EXCLUDED.avatar_url,
    updated_at = NOW();

  INSERT INTO public.users (
    id, email, full_name, account_type, created_at, updated_at, profile_completed
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'account_type', 'person'),
    NOW(),
    NOW(),
    false
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    updated_at = NOW();

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'handle_new_user error: %', SQLERRM;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_user_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.profiles
  SET
    email = NEW.email,
    updated_at = NOW()
  WHERE id = NEW.id;
  
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'handle_user_update error: %', SQLERRM;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_user_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_chat_member"("room_id" "uuid", "check_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM chat_room_member
    WHERE chat_room_id = room_id
    AND user_id = check_user_id
  );
END;
$$;


ALTER FUNCTION "public"."is_chat_member"("room_id" "uuid", "check_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_message_changes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Logger édition de message
  IF TG_OP = 'UPDATE' AND NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    INSERT INTO audit_log (user_id, action, table_name, record_id, old_data, new_data)
    VALUES (
      auth.uid(),
      'MESSAGE_EDITED',
      'messages',
      NEW.id,
      jsonb_build_object('content', OLD.content),
      jsonb_build_object('content', NEW.content)
    );
  END IF;
  
  -- Logger suppression de message
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    INSERT INTO audit_log (user_id, action, table_name, record_id, old_data)
    VALUES (
      auth.uid(),
      'MESSAGE_DELETED',
      'messages',
      NEW.id,
      jsonb_build_object('content', OLD.content)
    );
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."log_message_changes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_avatar_from_users"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Si l'avatar change dans users, le copier dans profiles
  IF NEW.avatar IS DISTINCT FROM OLD.avatar THEN
    UPDATE profiles
    SET avatar_url = NEW.avatar
    WHERE id = NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_avatar_from_users"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_user_to_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE profiles
  SET
    bio          = COALESCE(NULLIF(NEW.bio, ''), bio),
    full_name    = COALESCE(NULLIF(NEW.full_name, ''), full_name),
    company_name = COALESCE(NULLIF(NEW.company_name, ''), company_name),
    account_type = COALESCE(NULLIF(NEW.account_type, ''), account_type),
    avatar_url   = COALESCE(NULLIF(NEW.avatar, ''), avatar_url)
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_user_to_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_message_content"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Le contenu ne peut pas être vide (sauf si supprimé)
  IF NEW.deleted_at IS NULL AND (NEW.content IS NULL OR TRIM(NEW.content) = '') THEN
    RAISE EXCEPTION 'Message content cannot be empty';
  END IF;
  
  -- Limite de caractères : 5000
  IF LENGTH(NEW.content) > 5000 THEN
    RAISE EXCEPTION 'Message content cannot exceed 5000 characters';
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."validate_message_content"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."admin_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "admin_id" "uuid" NOT NULL,
    "admin_email" "text" NOT NULL,
    "action" "text" NOT NULL,
    "target_type" "text",
    "target_id" "text",
    "details" "jsonb",
    "ip_address" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "table_name" "text",
    "record_id" "uuid",
    "old_data" "jsonb",
    "new_data" "jsonb",
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_addresses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "label" character varying(50) DEFAULT 'Domicile'::character varying NOT NULL,
    "full_name" character varying(255),
    "address_line1" character varying(255) NOT NULL,
    "city" character varying(100) NOT NULL,
    "province" character(2) NOT NULL,
    "postal_code" character varying(10) NOT NULL,
    "country" character(2) DEFAULT 'CA'::"bpchar" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."billing_addresses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."blocked_users" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "blocker_id" "uuid" NOT NULL,
    "blocked_user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."blocked_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "service_id" "uuid",
    "client_id" "uuid",
    "worker_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "payment_status" "text" DEFAULT 'unpaid'::"text",
    "client_description" "text",
    "completed_by_worker" boolean DEFAULT false,
    "completed_by_client" boolean DEFAULT false,
    "worker_note" "text",
    "custom_price" numeric(10,2),
    "last_modified_at" timestamp with time zone,
    "modified_fields" "text"[],
    "cancel_requested_by" "uuid",
    "cancel_reason" "text",
    "tax_rate" numeric(6,5) DEFAULT NULL::numeric,
    "completed_at" timestamp with time zone,
    "client_province" character varying(2),
    "deposit_amount_cents" integer DEFAULT 0 NOT NULL,
    "estimated_hours" numeric(8,2),
    "pricing_mode" character varying(16),
    "approved_hours_total" numeric(10,2) DEFAULT 0 NOT NULL,
    "paid_service_base_cents" integer DEFAULT 0 NOT NULL,
    "balance_due_cents" integer DEFAULT 0 NOT NULL,
    "price_confirmed_by_client_at" timestamp with time zone,
    "price_confirmed_by_worker_at" timestamp with time zone,
    "custom_price_min" numeric(10,2),
    "custom_price_max" numeric(10,2),
    "deposit_enabled" boolean,
    "deposit_type" character varying(16),
    "deposit_value" numeric(10,2),
    "client_proposed_price" numeric(10,2),
    "worker_proposed_price" numeric(10,2),
    "price_selected_by_client" numeric(10,2),
    "price_selected_by_worker" numeric(10,2),
    "price_selected_source_by_client" character varying(16),
    "price_selected_source_by_worker" character varying(16)
);


ALTER TABLE "public"."bookings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_event_google_sync" (
    "calendar_event_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "google_event_id" character varying(256) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."calendar_event_google_sync" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid" NOT NULL,
    "service_id" "uuid" NOT NULL,
    "title" character varying(300) NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "location" "text",
    "notes" "text",
    "status" character varying(20) DEFAULT 'scheduled'::character varying NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "google_event_id" character varying(256),
    "confirmed_by_client" boolean DEFAULT false NOT NULL,
    "confirmed_by_worker" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."calendar_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "image_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_room" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_group" boolean DEFAULT false
);


ALTER TABLE "public"."chat_room" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_room_member" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "chat_room_id" "uuid",
    "user_id" "uuid",
    "joined_at" timestamp with time zone DEFAULT "now"(),
    "is_archived" boolean DEFAULT false,
    "last_reminder_sent_at" timestamp with time zone,
    "is_deleted" boolean DEFAULT false NOT NULL,
    "is_muted" boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY "public"."chat_room_member" REPLICA IDENTITY FULL;


ALTER TABLE "public"."chat_room_member" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "message" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_submissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dispute_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dispute_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "attachments" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dispute_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."disputes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid",
    "raised_by" "uuid",
    "description" "text",
    "status" "text" DEFAULT 'open'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "resolution" "text",
    "refund_percentage" numeric(5,2)
);


ALTER TABLE "public"."disputes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."favorites" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "favorited_user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."favorites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ledger_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid",
    "user_id" "uuid",
    "entry_type" "text" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "currency" "text" DEFAULT 'cad'::"text" NOT NULL,
    "stripe_object_id" "text",
    "stripe_object_type" "text",
    "description" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ledger_entries_entry_type_check" CHECK (("entry_type" = ANY (ARRAY['client_payment'::"text", 'buyer_commission'::"text", 'tax_collected'::"text", 'worker_payable'::"text", 'worker_payout'::"text", 'worker_commission'::"text", 'refund'::"text"])))
);


ALTER TABLE "public"."ledger_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."listing_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reporter_id" "uuid",
    "listing_id" "uuid",
    "reported_user_id" "uuid",
    "reason" "text" NOT NULL,
    "description" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."listing_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "chat_room_id" "uuid",
    "user_id" "uuid",
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "client_temp_id" "text",
    "replied_to_message_id" "uuid",
    "reactions" "jsonb" DEFAULT '[]'::"jsonb",
    "deleted_at" timestamp without time zone,
    "read_at" timestamp without time zone,
    "edited_at" timestamp without time zone,
    "pinned_at" timestamp without time zone,
    "email_notified_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."messages" REPLICA IDENTITY FULL;


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "user_id" "uuid" NOT NULL,
    "email_messages" boolean DEFAULT true NOT NULL,
    "email_payments" boolean DEFAULT true NOT NULL,
    "email_listings" boolean DEFAULT true NOT NULL,
    "email_complaints" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "link" "text",
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" integer NOT NULL,
    "booking_id" integer,
    "service_id" integer NOT NULL,
    "buyer_id" "uuid" NOT NULL,
    "seller_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "currency" "text" DEFAULT 'cad'::"text" NOT NULL,
    "status" "text" NOT NULL,
    "stripe_payment_intent_id" "text",
    "stripe_checkout_session_id" "text",
    "stripe_transfer_id" "text",
    "transfer_group" "text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."orders_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."orders_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."orders_id_seq" OWNED BY "public"."orders"."id";



CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid",
    "amount" numeric,
    "status" "text" DEFAULT 'pending'::"text",
    "payment_method" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "stripe_payment_intent_id" "text",
    "stripe_checkout_session_id" "text",
    "stripe_transfer_id" "text",
    "platform_fee" integer DEFAULT 0,
    "transfer_group" "text",
    "currency" "text" DEFAULT 'cad'::"text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deposit_amount_cents" integer DEFAULT 0 NOT NULL,
    "payment_kind" character varying(16) DEFAULT 'full'::character varying NOT NULL
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_earnings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid",
    "type" "text" NOT NULL,
    "amount" numeric(10,2) NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "platform_earnings_type_check" CHECK (("type" = ANY (ARRAY['buyer_commission'::"text", 'worker_commission'::"text"])))
);


ALTER TABLE "public"."platform_earnings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" character varying(255) NOT NULL,
    "account_type" character varying(50) DEFAULT 'person'::character varying,
    "full_name" character varying(255),
    "company_name" character varying(255),
    "avatar_url" "text",
    "avatar" "text",
    "bio" "text",
    "rating" numeric(3,2) DEFAULT 0,
    "jobs_completed" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "city" character varying(255),
    "province" character varying(255),
    "profession" character varying(255),
    "industry" character varying(255),
    "phone" character varying(50),
    "postal_code" character varying(20),
    "skills" "jsonb",
    "languages" "jsonb",
    "portfolio" "jsonb",
    "team_size" integer
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid",
    "reviewer_id" "uuid",
    "target_id" "uuid",
    "rating" integer,
    "comment" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "reviews_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."service_favorites" (
    "user_id" "uuid" NOT NULL,
    "service_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."service_favorites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."services" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "category" "text",
    "price" numeric,
    "location" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "category_id" "uuid",
    "type" character varying(20) DEFAULT 'offer'::character varying,
    "poster_type" character varying(20),
    "subcategory" character varying(100),
    "availability" character varying(50),
    "language" character varying(50),
    "mobility" character varying(50),
    "duration" character varying(100),
    "urgency" character varying(50),
    "image_url" "text",
    "is_one_time" boolean DEFAULT false,
    "is_active" boolean DEFAULT true,
    "address" "text",
    "latitude" double precision,
    "longitude" double precision,
    "city" "text",
    "image_urls" "text"[] DEFAULT '{}'::"text"[],
    "hide_exact_location" boolean DEFAULT false NOT NULL,
    "translations" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "pricing_mode" "text" DEFAULT 'fixed'::"text" NOT NULL,
    "price_min" numeric,
    "price_max" numeric,
    "listing_tags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "has_custom_tags" boolean DEFAULT false NOT NULL,
    "deposit_enabled" boolean DEFAULT false NOT NULL,
    "deposit_type" character varying(16),
    "deposit_value" numeric(10,2),
    "estimated_hours" numeric(8,2),
    "is_public" boolean DEFAULT true NOT NULL,
    "locations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "services_pricing_mode_check" CHECK (("pricing_mode" = ANY (ARRAY['fixed'::"text", 'range'::"text", 'quote'::"text", 'hourly'::"text"])))
);


ALTER TABLE "public"."services" OWNER TO "postgres";


COMMENT ON COLUMN "public"."services"."translations" IS 'title/description par locale; titre/description canonique pour recherche.';



COMMENT ON COLUMN "public"."services"."pricing_mode" IS 'fixed = prix listing ; range = fourchette ; quote = prix à convenir (paiement après custom_price)';



COMMENT ON COLUMN "public"."services"."price_min" IS 'Pour range = même borne basse que price en général';



COMMENT ON COLUMN "public"."services"."price_max" IS 'Pour range = borne haute';



CREATE TABLE IF NOT EXISTS "public"."stripe_accounts" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "stripe_account_id" "text" NOT NULL,
    "details_submitted" boolean DEFAULT false,
    "charges_enabled" boolean DEFAULT false,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "account_type" "text" DEFAULT 'express'::"text" NOT NULL
);


ALTER TABLE "public"."stripe_accounts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."stripe_accounts_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."stripe_accounts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."stripe_accounts_id_seq" OWNED BY "public"."stripe_accounts"."id";



CREATE TABLE IF NOT EXISTS "public"."stripe_customers" (
    "user_id" "uuid" NOT NULL,
    "stripe_customer_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."stripe_customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subcategories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid",
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "category_name" "text"
);


ALTER TABLE "public"."subcategories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_tickets" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "subject" "text",
    "category" "text",
    "description" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text",
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."support_tickets" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."support_tickets_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."support_tickets_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."support_tickets_id_seq" OWNED BY "public"."support_tickets"."id";



CREATE TABLE IF NOT EXISTS "public"."transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "booking_id" "uuid",
    "type" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "description" "text",
    "other_user_name" "text",
    "listing_title" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "transactions_type_check" CHECK (("type" = ANY (ARRAY['credit'::"text", 'debit'::"text"])))
);


ALTER TABLE "public"."transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."typing_indicators" (
    "chat_room_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE ONLY "public"."typing_indicators" REPLICA IDENTITY FULL;


ALTER TABLE "public"."typing_indicators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_presence" (
    "user_id" "uuid" NOT NULL,
    "is_online" boolean DEFAULT false,
    "last_seen" timestamp with time zone DEFAULT "now"(),
    "active_chat_id" "text"
);

ALTER TABLE ONLY "public"."user_presence" REPLICA IDENTITY FULL;


ALTER TABLE "public"."user_presence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_reports" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "reporter_id" "uuid" NOT NULL,
    "reported_user_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "phone" "text",
    "address" "text",
    "city" "text",
    "province" "text",
    "bio" "text",
    "avatar" "text",
    "account_type" "text",
    "profession" "text",
    "languages" "jsonb",
    "experiences" "jsonb",
    "company_name" "text",
    "industry" "text",
    "team_size" "text",
    "portfolio" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "profile_completed" boolean DEFAULT false,
    "skills" "jsonb",
    "password" character varying(255),
    "settings" "jsonb" DEFAULT '{"region": "CA", "privacy": {"showProfile": true, "showReviews": true, "showLocation": false}, "language": "en", "notifications": {"sms": false, "push": true, "email": true, "marketing": false}}'::"jsonb",
    "date_of_birth" "date",
    "postal_code" character varying(10),
    "is_suspended" boolean DEFAULT false NOT NULL,
    "calendar_ics_token" character varying(64),
    "google_calendar_refresh_token" "text",
    "google_calendar_access_token" "text",
    "google_calendar_token_expiry" timestamp with time zone,
    "welcome_email_sent_at" timestamp with time zone,
    CONSTRAINT "users_account_type_check" CHECK (("account_type" = ANY (ARRAY['person'::"text", 'company'::"text"])))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."waitlist" (
    "id" integer NOT NULL,
    "email" "text" NOT NULL,
    "lang" "text" DEFAULT 'fr'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."waitlist" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."waitlist_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."waitlist_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."waitlist_id_seq" OWNED BY "public"."waitlist"."id";



CREATE TABLE IF NOT EXISTS "public"."wallets" (
    "user_id" "uuid" NOT NULL,
    "balance" numeric DEFAULT 0,
    "total_earned" numeric DEFAULT 0,
    "total_spent" numeric DEFAULT 0,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."wallets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid" NOT NULL,
    "service_id" "uuid" NOT NULL,
    "calendar_event_id" "uuid",
    "title" character varying(300) DEFAULT 'Session'::character varying NOT NULL,
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "hours_worker" numeric(8,2),
    "hours_client" numeric(8,2),
    "hours_final" numeric(8,2),
    "status" character varying(32) DEFAULT 'scheduled'::character varying NOT NULL,
    "worker_note" "text",
    "client_note" "text",
    "last_actor" "uuid",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."work_sessions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."orders" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."orders_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."stripe_accounts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."stripe_accounts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."support_tickets" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."support_tickets_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."waitlist" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."waitlist_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."admin_audit_logs"
    ADD CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_addresses"
    ADD CONSTRAINT "billing_addresses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."blocked_users"
    ADD CONSTRAINT "blocked_users_blocker_id_blocked_user_id_key" UNIQUE ("blocker_id", "blocked_user_id");



ALTER TABLE ONLY "public"."blocked_users"
    ADD CONSTRAINT "blocked_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_event_google_sync"
    ADD CONSTRAINT "calendar_event_google_sync_pkey" PRIMARY KEY ("calendar_event_id", "user_id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_room_member"
    ADD CONSTRAINT "chat_room_member_chat_room_id_user_id_key" UNIQUE ("chat_room_id", "user_id");



ALTER TABLE ONLY "public"."chat_room_member"
    ADD CONSTRAINT "chat_room_member_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_room"
    ADD CONSTRAINT "chat_room_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_submissions"
    ADD CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dispute_messages"
    ADD CONSTRAINT "dispute_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."favorites"
    ADD CONSTRAINT "favorites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."favorites"
    ADD CONSTRAINT "favorites_user_id_favorited_user_id_key" UNIQUE ("user_id", "favorited_user_id");



ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."listing_reports"
    ADD CONSTRAINT "listing_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_earnings"
    ADD CONSTRAINT "platform_earnings_booking_id_type_key" UNIQUE ("booking_id", "type");



ALTER TABLE ONLY "public"."platform_earnings"
    ADD CONSTRAINT "platform_earnings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_endpoint_key" UNIQUE ("user_id", "endpoint");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."service_favorites"
    ADD CONSTRAINT "service_favorites_pkey" PRIMARY KEY ("user_id", "service_id");



ALTER TABLE ONLY "public"."services"
    ADD CONSTRAINT "services_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_accounts"
    ADD CONSTRAINT "stripe_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_accounts"
    ADD CONSTRAINT "stripe_accounts_stripe_account_id_key" UNIQUE ("stripe_account_id");



ALTER TABLE ONLY "public"."stripe_accounts"
    ADD CONSTRAINT "stripe_accounts_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."stripe_customers"
    ADD CONSTRAINT "stripe_customers_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."stripe_customers"
    ADD CONSTRAINT "stripe_customers_stripe_customer_id_key" UNIQUE ("stripe_customer_id");



ALTER TABLE ONLY "public"."subcategories"
    ADD CONSTRAINT "subcategories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."typing_indicators"
    ADD CONSTRAINT "typing_indicators_pkey" PRIMARY KEY ("chat_room_id", "user_id");



ALTER TABLE ONLY "public"."user_presence"
    ADD CONSTRAINT "user_presence_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_calendar_ics_token_key" UNIQUE ("calendar_ics_token");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."waitlist"
    ADD CONSTRAINT "waitlist_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."waitlist"
    ADD CONSTRAINT "waitlist_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."work_sessions"
    ADD CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id");



CREATE INDEX "dispute_messages_created_at_idx" ON "public"."dispute_messages" USING "btree" ("created_at");



CREATE INDEX "dispute_messages_dispute_id_idx" ON "public"."dispute_messages" USING "btree" ("dispute_id");



CREATE INDEX "idx_aal_action" ON "public"."admin_audit_logs" USING "btree" ("action");



CREATE INDEX "idx_aal_admin_id" ON "public"."admin_audit_logs" USING "btree" ("admin_id");



CREATE INDEX "idx_aal_created_at" ON "public"."admin_audit_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_audit_action" ON "public"."audit_log" USING "btree" ("action");



CREATE INDEX "idx_audit_created" ON "public"."audit_log" USING "btree" ("created_at");



CREATE INDEX "idx_audit_user" ON "public"."audit_log" USING "btree" ("user_id");



CREATE INDEX "idx_billing_addresses_user_id" ON "public"."billing_addresses" USING "btree" ("user_id");



CREATE INDEX "idx_bookings_client_id" ON "public"."bookings" USING "btree" ("client_id");



CREATE INDEX "idx_bookings_client_status" ON "public"."bookings" USING "btree" ("client_id", "status");



CREATE INDEX "idx_bookings_created_at" ON "public"."bookings" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_bookings_service_id" ON "public"."bookings" USING "btree" ("service_id");



CREATE INDEX "idx_bookings_service_status" ON "public"."bookings" USING "btree" ("service_id", "status");



CREATE INDEX "idx_bookings_status" ON "public"."bookings" USING "btree" ("status");



CREATE INDEX "idx_bookings_worker_id" ON "public"."bookings" USING "btree" ("worker_id");



CREATE INDEX "idx_bookings_worker_status" ON "public"."bookings" USING "btree" ("worker_id", "status");



CREATE INDEX "idx_calendar_events_booking" ON "public"."calendar_events" USING "btree" ("booking_id");



CREATE INDEX "idx_calendar_events_service" ON "public"."calendar_events" USING "btree" ("service_id");



CREATE INDEX "idx_calendar_events_starts" ON "public"."calendar_events" USING "btree" ("starts_at");



CREATE INDEX "idx_chat_room_member_user" ON "public"."chat_room_member" USING "btree" ("user_id");



CREATE INDEX "idx_disputes_booking_id" ON "public"."disputes" USING "btree" ("booking_id");



CREATE INDEX "idx_disputes_booking_status" ON "public"."disputes" USING "btree" ("booking_id", "status");



CREATE INDEX "idx_disputes_status" ON "public"."disputes" USING "btree" ("status");



CREATE INDEX "idx_favorites_favorited_user_id" ON "public"."favorites" USING "btree" ("favorited_user_id");



CREATE INDEX "idx_favorites_user_id" ON "public"."favorites" USING "btree" ("user_id");



CREATE INDEX "idx_messages_chat_room" ON "public"."messages" USING "btree" ("chat_room_id", "created_at" DESC);



CREATE INDEX "idx_messages_deleted_at" ON "public"."messages" USING "btree" ("deleted_at");



CREATE INDEX "idx_messages_edited" ON "public"."messages" USING "btree" ("edited_at");



CREATE INDEX "idx_messages_pinned" ON "public"."messages" USING "btree" ("chat_room_id", "pinned_at") WHERE ("pinned_at" IS NOT NULL);



CREATE INDEX "idx_messages_reactions" ON "public"."messages" USING "gin" ("reactions");



CREATE INDEX "idx_messages_read_at" ON "public"."messages" USING "btree" ("read_at");



CREATE INDEX "idx_messages_replied_to" ON "public"."messages" USING "btree" ("replied_to_message_id");



CREATE INDEX "idx_messages_unread" ON "public"."messages" USING "btree" ("chat_room_id", "user_id", "read_at") WHERE ("read_at" IS NULL);



CREATE INDEX "idx_payments_booking_id" ON "public"."payments" USING "btree" ("booking_id");



CREATE INDEX "idx_payments_status" ON "public"."payments" USING "btree" ("status");



CREATE INDEX "idx_reviews_booking_id" ON "public"."reviews" USING "btree" ("booking_id");



CREATE INDEX "idx_reviews_created_at" ON "public"."reviews" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_reviews_target_created" ON "public"."reviews" USING "btree" ("target_id", "created_at" DESC);



CREATE INDEX "idx_reviews_target_id" ON "public"."reviews" USING "btree" ("target_id");



CREATE INDEX "idx_service_favorites_service_id" ON "public"."service_favorites" USING "btree" ("service_id");



CREATE INDEX "idx_service_favorites_user" ON "public"."service_favorites" USING "btree" ("user_id");



CREATE INDEX "idx_service_favorites_user_id" ON "public"."service_favorites" USING "btree" ("user_id");



CREATE INDEX "idx_services_created_at" ON "public"."services" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_services_has_custom_tags" ON "public"."services" USING "btree" ("has_custom_tags") WHERE ("has_custom_tags" = true);



CREATE INDEX "idx_services_is_active" ON "public"."services" USING "btree" ("is_active");



CREATE INDEX "idx_services_is_public" ON "public"."services" USING "btree" ("is_public") WHERE ("is_public" = true);



CREATE INDEX "idx_services_listing_tags" ON "public"."services" USING "gin" ("listing_tags");



CREATE INDEX "idx_services_user_active" ON "public"."services" USING "btree" ("user_id", "is_active");



CREATE INDEX "idx_services_user_id" ON "public"."services" USING "btree" ("user_id");



CREATE INDEX "idx_stripe_accounts_user_id" ON "public"."stripe_accounts" USING "btree" ("user_id");



CREATE INDEX "idx_transactions_booking_id" ON "public"."transactions" USING "btree" ("booking_id");



CREATE INDEX "idx_transactions_created_at" ON "public"."transactions" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_transactions_user_created" ON "public"."transactions" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_transactions_user_id" ON "public"."transactions" USING "btree" ("user_id");



CREATE INDEX "idx_transactions_user_type" ON "public"."transactions" USING "btree" ("user_id", "type");



CREATE INDEX "idx_users_account_type" ON "public"."users" USING "btree" ("account_type");



CREATE INDEX "idx_users_email" ON "public"."users" USING "btree" ("email");



CREATE INDEX "idx_work_sessions_booking" ON "public"."work_sessions" USING "btree" ("booking_id");



CREATE INDEX "idx_work_sessions_status" ON "public"."work_sessions" USING "btree" ("status");



CREATE INDEX "ledger_entries_booking_idx" ON "public"."ledger_entries" USING "btree" ("booking_id");



CREATE INDEX "ledger_entries_created_idx" ON "public"."ledger_entries" USING "btree" ("created_at");



CREATE UNIQUE INDEX "ledger_entries_stripe_unique" ON "public"."ledger_entries" USING "btree" ("stripe_object_id", "entry_type") WHERE ("stripe_object_id" IS NOT NULL);



CREATE INDEX "ledger_entries_type_idx" ON "public"."ledger_entries" USING "btree" ("entry_type");



CREATE INDEX "messages_chat_room_id_idx" ON "public"."messages" USING "btree" ("chat_room_id");



CREATE INDEX "messages_client_temp_id_idx" ON "public"."messages" USING "btree" ("client_temp_id");



CREATE INDEX "messages_created_at_idx" ON "public"."messages" USING "btree" ("chat_room_id", "created_at" DESC);



CREATE INDEX "messages_user_id_idx" ON "public"."messages" USING "btree" ("user_id");



CREATE INDEX "notifications_created_at_idx" ON "public"."notifications" USING "btree" ("created_at" DESC);



CREATE INDEX "notifications_user_id_idx" ON "public"."notifications" USING "btree" ("user_id");



CREATE UNIQUE INDEX "payments_stripe_checkout_session_id_key" ON "public"."payments" USING "btree" ("stripe_checkout_session_id") WHERE ("stripe_checkout_session_id" IS NOT NULL);



CREATE INDEX "profiles_account_type_idx" ON "public"."profiles" USING "btree" ("account_type");



CREATE INDEX "profiles_email_idx" ON "public"."profiles" USING "btree" ("email");



CREATE OR REPLACE TRIGGER "audit_message_changes" AFTER UPDATE ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."log_message_changes"();



CREATE OR REPLACE TRIGGER "edit_time_limit_trigger" BEFORE UPDATE ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."check_edit_time_limit"();



CREATE OR REPLACE TRIGGER "message_rate_limit_trigger" BEFORE INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."check_message_rate_limit"();




CREATE OR REPLACE TRIGGER "sync_avatar_on_update" AFTER UPDATE OF "avatar" ON "public"."users" FOR EACH ROW WHEN (("new"."avatar" IS DISTINCT FROM "old"."avatar")) EXECUTE FUNCTION "public"."sync_avatar_from_users"();



CREATE OR REPLACE TRIGGER "sync_avatar_on_users_update" AFTER UPDATE OF "avatar" ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."sync_avatar_from_users"();



CREATE OR REPLACE TRIGGER "trg_sync_user_to_profile" AFTER UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."sync_user_to_profile"();



CREATE OR REPLACE TRIGGER "update_users_updated_at" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "validate_content_trigger" BEFORE INSERT OR UPDATE ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."validate_message_content"();



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."billing_addresses"
    ADD CONSTRAINT "billing_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blocked_users"
    ADD CONSTRAINT "blocked_users_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blocked_users"
    ADD CONSTRAINT "blocked_users_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_cancel_requested_by_fkey" FOREIGN KEY ("cancel_requested_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_event_google_sync"
    ADD CONSTRAINT "calendar_event_google_sync_calendar_event_id_fkey" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_event_google_sync"
    ADD CONSTRAINT "calendar_event_google_sync_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_room_member"
    ADD CONSTRAINT "chat_room_member_chat_room_id_fkey" FOREIGN KEY ("chat_room_id") REFERENCES "public"."chat_room"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_room_member"
    ADD CONSTRAINT "chat_room_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dispute_messages"
    ADD CONSTRAINT "dispute_messages_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id");



ALTER TABLE ONLY "public"."favorites"
    ADD CONSTRAINT "favorites_favorited_user_id_fkey" FOREIGN KEY ("favorited_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."favorites"
    ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."listing_reports"
    ADD CONSTRAINT "listing_reports_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "public"."services"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."listing_reports"
    ADD CONSTRAINT "listing_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."listing_reports"
    ADD CONSTRAINT "listing_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_chat_room_id_fkey" FOREIGN KEY ("chat_room_id") REFERENCES "public"."chat_room"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_replied_to_message_id_fkey" FOREIGN KEY ("replied_to_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id");



ALTER TABLE ONLY "public"."platform_earnings"
    ADD CONSTRAINT "platform_earnings_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."service_favorites"
    ADD CONSTRAINT "service_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."services"
    ADD CONSTRAINT "services_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id");



ALTER TABLE ONLY "public"."stripe_customers"
    ADD CONSTRAINT "stripe_customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subcategories"
    ADD CONSTRAINT "subcategories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."typing_indicators"
    ADD CONSTRAINT "typing_indicators_chat_room_id_fkey" FOREIGN KEY ("chat_room_id") REFERENCES "public"."chat_room"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."typing_indicators"
    ADD CONSTRAINT "typing_indicators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_presence"
    ADD CONSTRAINT "user_presence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_sessions"
    ADD CONSTRAINT "work_sessions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_sessions"
    ADD CONSTRAINT "work_sessions_calendar_event_id_fkey" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_sessions"
    ADD CONSTRAINT "work_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."work_sessions"
    ADD CONSTRAINT "work_sessions_last_actor_fkey" FOREIGN KEY ("last_actor") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."work_sessions"
    ADD CONSTRAINT "work_sessions_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE CASCADE;



CREATE POLICY "Admin audit logs: no direct user access" ON "public"."admin_audit_logs" USING (false);



CREATE POLICY "Anyone can submit contact form" ON "public"."contact_submissions" FOR INSERT TO "authenticated", "anon" WITH CHECK ((("char_length"(TRIM(BOTH FROM "first_name")) > 0) AND ("char_length"(TRIM(BOTH FROM "last_name")) > 0) AND ("email" ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'::"text") AND ("char_length"(TRIM(BOTH FROM "message")) > 0) AND ("subject" = ANY (ARRAY['account'::"text", 'payment'::"text", 'dispute'::"text", 'listing'::"text", 'safety'::"text", 'partnership'::"text", 'other'::"text"]))));



CREATE POLICY "Anyone can view all profiles" ON "public"."profiles" FOR SELECT USING (true);



CREATE POLICY "Only service role can read" ON "public"."contact_submissions" FOR SELECT TO "service_role" USING (true);



CREATE POLICY "Users can delete messages in their chats" ON "public"."messages" FOR DELETE USING (("chat_room_id" IN ( SELECT "chat_room_member"."chat_room_id"
   FROM "public"."chat_room_member"
  WHERE ("chat_room_member"."user_id" = "auth"."uid"()))));



CREATE POLICY "Users can delete own profile" ON "public"."profiles" FOR DELETE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can delete their own membership" ON "public"."chat_room_member" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can insert their own reports" ON "public"."listing_reports" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "reporter_id"));



CREATE POLICY "Users can read own profile" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."users" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update their own membership" ON "public"."chat_room_member" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view their own reports" ON "public"."listing_reports" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "reporter_id"));



CREATE POLICY "Users manage their own subscriptions" ON "public"."push_subscriptions" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."admin_audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_addresses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."blocked_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "blocked_users_delete" ON "public"."blocked_users" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "blocker_id"));



CREATE POLICY "blocked_users_insert" ON "public"."blocked_users" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "blocker_id"));



CREATE POLICY "blocked_users_select" ON "public"."blocked_users" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "blocker_id") OR (( SELECT "auth"."uid"() AS "uid") = "blocked_user_id")));



ALTER TABLE "public"."bookings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_event_google_sync" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_room" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_room_insert" ON "public"."chat_room" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."chat_room_member" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_room_policy" ON "public"."chat_room" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."chat_room_member"
  WHERE (("chat_room_member"."chat_room_id" = "chat_room"."id") AND ("chat_room_member"."user_id" = "auth"."uid"())))));



CREATE POLICY "chat_room_select" ON "public"."chat_room" FOR SELECT USING (("id" IN ( SELECT "public"."get_my_chat_room_ids"() AS "get_my_chat_room_ids")));



ALTER TABLE "public"."contact_submissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "crm_select" ON "public"."chat_room_member" FOR SELECT USING (("chat_room_id" IN ( SELECT "public"."get_my_chat_room_ids"() AS "get_my_chat_room_ids")));



CREATE POLICY "crm_update_own" ON "public"."chat_room_member" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."dispute_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."disputes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."favorites" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insert_messages" ON "public"."messages" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND "public"."is_chat_member"("chat_room_id", "auth"."uid"())));



CREATE POLICY "insert_own_messages" ON "public"."messages" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND ("chat_room_id" IN ( SELECT "chat_room_member"."chat_room_id"
   FROM "public"."chat_room_member"
  WHERE ("chat_room_member"."user_id" = "auth"."uid"())))));



CREATE POLICY "insert_self_as_member" ON "public"."chat_room_member" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."ledger_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."listing_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "msg_insert" ON "public"."messages" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND ("chat_room_id" IN ( SELECT "public"."get_my_chat_room_ids"() AS "get_my_chat_room_ids"))));



CREATE POLICY "msg_select" ON "public"."messages" FOR SELECT USING (("chat_room_id" IN ( SELECT "public"."get_my_chat_room_ids"() AS "get_my_chat_room_ids")));



CREATE POLICY "msg_update" ON "public"."messages" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_earnings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "presence_insert" ON "public"."user_presence" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "presence_select" ON "public"."user_presence" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "presence_update" ON "public"."user_presence" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reviews" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "select_chat_members" ON "public"."chat_room_member" FOR SELECT USING ("public"."is_chat_member"("chat_room_id", "auth"."uid"()));



CREATE POLICY "select_chat_messages" ON "public"."messages" FOR SELECT USING ("public"."is_chat_member"("chat_room_id", "auth"."uid"()));



CREATE POLICY "select_own_chat_rooms" ON "public"."chat_room" FOR SELECT TO "authenticated" USING (("id" IN ( SELECT "chat_room_member"."chat_room_id"
   FROM "public"."chat_room_member"
  WHERE ("chat_room_member"."user_id" = "auth"."uid"()))));



CREATE POLICY "select_own_chats" ON "public"."chat_room" FOR SELECT USING ("public"."is_chat_member"("id", "auth"."uid"()));



CREATE POLICY "select_own_memberships" ON "public"."chat_room_member" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "select_own_messages" ON "public"."messages" FOR SELECT TO "authenticated" USING (("chat_room_id" IN ( SELECT "chat_room_member"."chat_room_id"
   FROM "public"."chat_room_member"
  WHERE ("chat_room_member"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."service_favorites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."services" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "services_public_read" ON "public"."services" FOR SELECT USING (true);



CREATE POLICY "sf_delete" ON "public"."service_favorites" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "sf_insert" ON "public"."service_favorites" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "sf_select" ON "public"."service_favorites" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."stripe_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subcategories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."support_tickets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "transactions_select_own" ON "public"."transactions" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "typing_delete" ON "public"."typing_indicators" FOR DELETE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."typing_indicators" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "typing_indicators_policy" ON "public"."typing_indicators" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."chat_room_member"
  WHERE (("chat_room_member"."chat_room_id" = "typing_indicators"."chat_room_id") AND ("chat_room_member"."user_id" = "auth"."uid"())))));



CREATE POLICY "typing_select" ON "public"."typing_indicators" FOR SELECT USING (("chat_room_id" IN ( SELECT "public"."get_my_chat_room_ids"() AS "get_my_chat_room_ids")));



CREATE POLICY "typing_update" ON "public"."typing_indicators" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "typing_upsert" ON "public"."typing_indicators" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "update_own_chats" ON "public"."chat_room" FOR UPDATE USING ("public"."is_chat_member"("id", "auth"."uid"()));



CREATE POLICY "update_own_messages" ON "public"."messages" FOR UPDATE TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR ("chat_room_id" IN ( SELECT "chat_room_member"."chat_room_id"
   FROM "public"."chat_room_member"
  WHERE ("chat_room_member"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."user_presence" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_presence_policy" ON "public"."user_presence" TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."user_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_reports_insert" ON "public"."user_reports" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "reporter_id"));



CREATE POLICY "user_reports_select" ON "public"."user_reports" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "reporter_id"));



ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_can_read_own_bookings" ON "public"."bookings" FOR SELECT USING ((("auth"."uid"() = "worker_id") OR ("auth"."uid"() = "client_id")));



ALTER TABLE "public"."waitlist" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."wallets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wallets_select_own" ON "public"."wallets" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."work_sessions" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."bookings";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."chat_room_member";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."messages";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."typing_indicators";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."user_presence";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."check_edit_time_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_edit_time_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_edit_time_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."check_message_rate_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_message_rate_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_message_rate_limit"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_my_chat_room_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_my_chat_room_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_chat_room_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_or_create_direct_chat"("other_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_or_create_direct_chat"("other_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_or_create_direct_chat"("other_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_user_update"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_user_update"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_chat_member"("room_id" "uuid", "check_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_chat_member"("room_id" "uuid", "check_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_chat_member"("room_id" "uuid", "check_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_message_changes"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_message_changes"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_avatar_from_users"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_avatar_from_users"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_avatar_from_users"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_user_to_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_user_to_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_message_content"() TO "anon";
GRANT ALL ON FUNCTION "public"."validate_message_content"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_message_content"() TO "service_role";


















GRANT ALL ON TABLE "public"."admin_audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."admin_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."billing_addresses" TO "anon";
GRANT ALL ON TABLE "public"."billing_addresses" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_addresses" TO "service_role";



GRANT ALL ON TABLE "public"."blocked_users" TO "anon";
GRANT ALL ON TABLE "public"."blocked_users" TO "authenticated";
GRANT ALL ON TABLE "public"."blocked_users" TO "service_role";



GRANT ALL ON TABLE "public"."bookings" TO "anon";
GRANT ALL ON TABLE "public"."bookings" TO "authenticated";
GRANT ALL ON TABLE "public"."bookings" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_event_google_sync" TO "anon";
GRANT ALL ON TABLE "public"."calendar_event_google_sync" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_event_google_sync" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_events" TO "service_role";



GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";



GRANT ALL ON TABLE "public"."chat_room" TO "anon";
GRANT ALL ON TABLE "public"."chat_room" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_room" TO "service_role";



GRANT ALL ON TABLE "public"."chat_room_member" TO "anon";
GRANT ALL ON TABLE "public"."chat_room_member" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_room_member" TO "service_role";



GRANT ALL ON TABLE "public"."contact_submissions" TO "anon";
GRANT ALL ON TABLE "public"."contact_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_submissions" TO "service_role";



GRANT ALL ON TABLE "public"."dispute_messages" TO "anon";
GRANT ALL ON TABLE "public"."dispute_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_messages" TO "service_role";



GRANT ALL ON TABLE "public"."disputes" TO "anon";
GRANT ALL ON TABLE "public"."disputes" TO "authenticated";
GRANT ALL ON TABLE "public"."disputes" TO "service_role";



GRANT ALL ON TABLE "public"."favorites" TO "anon";
GRANT ALL ON TABLE "public"."favorites" TO "authenticated";
GRANT ALL ON TABLE "public"."favorites" TO "service_role";



GRANT ALL ON TABLE "public"."ledger_entries" TO "anon";
GRANT ALL ON TABLE "public"."ledger_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."ledger_entries" TO "service_role";



GRANT ALL ON TABLE "public"."listing_reports" TO "anon";
GRANT ALL ON TABLE "public"."listing_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."listing_reports" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."platform_earnings" TO "anon";
GRANT ALL ON TABLE "public"."platform_earnings" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_earnings" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."push_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."reviews" TO "anon";
GRANT ALL ON TABLE "public"."reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."reviews" TO "service_role";



GRANT ALL ON TABLE "public"."service_favorites" TO "anon";
GRANT ALL ON TABLE "public"."service_favorites" TO "authenticated";
GRANT ALL ON TABLE "public"."service_favorites" TO "service_role";



GRANT ALL ON TABLE "public"."services" TO "anon";
GRANT ALL ON TABLE "public"."services" TO "authenticated";
GRANT ALL ON TABLE "public"."services" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_accounts" TO "anon";
GRANT ALL ON TABLE "public"."stripe_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_accounts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."stripe_accounts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."stripe_accounts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."stripe_accounts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_customers" TO "anon";
GRANT ALL ON TABLE "public"."stripe_customers" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_customers" TO "service_role";



GRANT ALL ON TABLE "public"."subcategories" TO "anon";
GRANT ALL ON TABLE "public"."subcategories" TO "authenticated";
GRANT ALL ON TABLE "public"."subcategories" TO "service_role";



GRANT ALL ON TABLE "public"."support_tickets" TO "anon";
GRANT ALL ON TABLE "public"."support_tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."support_tickets" TO "service_role";



GRANT ALL ON SEQUENCE "public"."support_tickets_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."support_tickets_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."support_tickets_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."transactions" TO "anon";
GRANT ALL ON TABLE "public"."transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."transactions" TO "service_role";



GRANT ALL ON TABLE "public"."typing_indicators" TO "anon";
GRANT ALL ON TABLE "public"."typing_indicators" TO "authenticated";
GRANT ALL ON TABLE "public"."typing_indicators" TO "service_role";



GRANT ALL ON TABLE "public"."user_presence" TO "anon";
GRANT ALL ON TABLE "public"."user_presence" TO "authenticated";
GRANT ALL ON TABLE "public"."user_presence" TO "service_role";



GRANT ALL ON TABLE "public"."user_reports" TO "anon";
GRANT ALL ON TABLE "public"."user_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."user_reports" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON TABLE "public"."waitlist" TO "anon";
GRANT ALL ON TABLE "public"."waitlist" TO "authenticated";
GRANT ALL ON TABLE "public"."waitlist" TO "service_role";



GRANT ALL ON SEQUENCE "public"."waitlist_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."waitlist_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."waitlist_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."wallets" TO "anon";
GRANT ALL ON TABLE "public"."wallets" TO "authenticated";
GRANT ALL ON TABLE "public"."wallets" TO "service_role";



GRANT ALL ON TABLE "public"."work_sessions" TO "anon";
GRANT ALL ON TABLE "public"."work_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."work_sessions" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

































-- ============================================================================
-- auth.users triggers (not covered by the dump)
-- ============================================================================

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  WHEN (old.raw_user_meta_data IS DISTINCT FROM new.raw_user_meta_data)
  EXECUTE FUNCTION public.handle_user_update();


-- ============================================================================
-- Storage buckets + policies (not covered by the dump)
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('chat-attachments',    'chat-attachments',    true, 5242880, NULL),
  ('dispute-attachments', 'dispute-attachments', true, NULL,    NULL),
  ('listing-images',      'listing-images',      true, 5242880, ARRAY['image/webp','image/jpeg','image/png'])
ON CONFLICT (id) DO NOTHING;

-- chat-attachments
CREATE POLICY "Anyone can view chat attachments" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'chat-attachments');
CREATE POLICY "Authenticated users can read files" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'chat-attachments');
CREATE POLICY "Users can read files from their chats" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'chat-attachments');
CREATE POLICY "Users can upload chat attachments" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'chat-attachments');
CREATE POLICY "Authenticated users can upload files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users can upload to their own folder" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users can delete their own files" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- listing-images
CREATE POLICY "Anyone can view listing images" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'listing-images');
CREATE POLICY "Users can upload listing images to their own folder" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'listing-images' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users can delete their own listing images" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'listing-images' AND (storage.foldername(name))[1] = auth.uid()::text);
