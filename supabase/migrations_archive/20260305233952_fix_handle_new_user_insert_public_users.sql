
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Insert into public.profiles (existing)
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

  -- Insert into public.users (needed by backend)
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
