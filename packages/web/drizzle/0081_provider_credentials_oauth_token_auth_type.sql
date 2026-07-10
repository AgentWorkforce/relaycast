DO $$
BEGIN
  IF to_regclass('public.provider_credentials') IS NOT NULL
  THEN
    ALTER TABLE "provider_credentials"
      DROP CONSTRAINT IF EXISTS "provider_credentials_auth_type_check";

    ALTER TABLE "provider_credentials"
      ADD CONSTRAINT "provider_credentials_auth_type_check"
      CHECK ("auth_type" IN ('provider_oauth', 'byo_api_key', 'relay_managed', 'oauth_token'));
  END IF;
END $$;
