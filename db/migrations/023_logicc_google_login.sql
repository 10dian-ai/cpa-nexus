-- Google OAuth credentials for Logicc accounts: an account registered through
-- Google has no Logicc password, so it is renewed by replaying the OAuth flow
-- (email + password + TOTP) in the gauth mini-kernel, which harvests a fresh
-- `__client` and session. All values are encrypted at rest; only the email
-- hash is stored in the clear, to dedupe accounts before their first session.

ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS google_email_ciphertext TEXT;
ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS google_password_ciphertext TEXT;
ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS google_totp_ciphertext TEXT;
ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS google_profile_ciphertext TEXT;
ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS google_email_hash TEXT;

-- An account must carry something to authenticate with: a cookie, a JWT, a
-- password to sign in with, or Google credentials for the gauth kernel.
ALTER TABLE logicc_accounts DROP CONSTRAINT IF EXISTS logicc_accounts_credentials_check;
ALTER TABLE logicc_accounts ADD CONSTRAINT logicc_accounts_credentials_check
 CHECK(client_cookie_ciphertext IS NOT NULL OR token_ciphertext IS NOT NULL
   OR login_password_ciphertext IS NOT NULL OR google_password_ciphertext IS NOT NULL);

-- One account per Google email while it has no session yet.
CREATE UNIQUE INDEX IF NOT EXISTS logicc_accounts_google_email ON logicc_accounts(google_email_hash) WHERE google_email_hash IS NOT NULL;
