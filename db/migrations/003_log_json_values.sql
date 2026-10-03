-- Earlier writes passed JSON.stringify(value) to a JSONB parameter, which
-- postgres.js encoded again. Repair only encoded objects/arrays; keep plain
-- text, scalar JSON, nulls, and already structured values unchanged.
CREATE FUNCTION pg_temp.ccm_unpack_log_json(value JSONB) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE decoded JSONB;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RETURN value; END IF;
  BEGIN
    decoded := (value #>> '{}')::jsonb;
  EXCEPTION WHEN invalid_text_representation OR untranslatable_character OR numeric_value_out_of_range THEN RETURN value;
  END;
  IF jsonb_typeof(decoded) IN ('object', 'array') THEN RETURN decoded; END IF;
  RETURN value;
END;
$$;

UPDATE request_logs SET
  request_body = pg_temp.ccm_unpack_log_json(request_body),
  response_body = pg_temp.ccm_unpack_log_json(response_body),
  usage = pg_temp.ccm_unpack_log_json(usage)
WHERE jsonb_typeof(request_body) = 'string'
   OR jsonb_typeof(response_body) = 'string'
   OR jsonb_typeof(usage) = 'string';

DROP FUNCTION pg_temp.ccm_unpack_log_json(JSONB);
