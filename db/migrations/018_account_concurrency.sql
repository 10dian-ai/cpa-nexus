-- Match the API's positive INTEGER range for both extension account pools.
-- Existing installations must drop the old 1..100 constraints as well.
ALTER TABLE managed_accounts DROP CONSTRAINT IF EXISTS managed_accounts_max_concurrency_check;
ALTER TABLE managed_accounts ADD CONSTRAINT managed_accounts_max_concurrency_check
  CHECK(max_concurrency > 0);

ALTER TABLE devin2api_accounts DROP CONSTRAINT IF EXISTS devin2api_accounts_max_concurrency_check;
ALTER TABLE devin2api_accounts ADD CONSTRAINT devin2api_accounts_max_concurrency_check
  CHECK(max_concurrency > 0);
