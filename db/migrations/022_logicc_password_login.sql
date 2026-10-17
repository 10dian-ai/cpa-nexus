-- Optional email+password credentials for Logicc accounts, so an expired
-- session can be renewed with a normal Clerk sign-in instead of a hand-pasted
-- cookie. The email and password are encrypted at rest and never returned by
-- any page or API. A password account has no session until its first login,
-- so session_id becomes nullable and the account is deduplicated by the hash
-- of its login email until a session exists.

ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS login_email_ciphertext TEXT;
ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS login_password_ciphertext TEXT;
ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS login_email_hash TEXT;
ALTER TABLE logicc_accounts ADD COLUMN IF NOT EXISTS auto_login BOOLEAN NOT NULL DEFAULT true;

-- A password account begins without a session; the format check still holds for a present value.
ALTER TABLE logicc_accounts ALTER COLUMN session_id DROP NOT NULL;

-- `needs_login`: automatic sign-in was blocked (a human verification such as a
-- captcha is required), the account is out of the pool until someone completes it.
ALTER TABLE logicc_accounts DROP CONSTRAINT IF EXISTS logicc_accounts_status_check;
ALTER TABLE logicc_accounts ADD CONSTRAINT logicc_accounts_status_check
 CHECK(status IN ('pending','ready','credential_expired','sync_error','needs_login'));

-- An account must carry something to authenticate with: a cookie, a JWT, or a password to sign in with.
ALTER TABLE logicc_accounts DROP CONSTRAINT IF EXISTS logicc_accounts_check;
ALTER TABLE logicc_accounts ADD CONSTRAINT logicc_accounts_credentials_check
 CHECK(client_cookie_ciphertext IS NOT NULL OR token_ciphertext IS NOT NULL OR login_password_ciphertext IS NOT NULL);

-- One account per login email while it has no session yet; afterwards session_id keeps it unique.
CREATE UNIQUE INDEX IF NOT EXISTS logicc_accounts_login_email ON logicc_accounts(login_email_hash) WHERE login_email_hash IS NOT NULL;
