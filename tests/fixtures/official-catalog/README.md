Public Command Code website/API fixtures captured on 2026-10-03. No credentials.
HTML files retain structured loader/RSC records needed by the parser.

- `models.html`: https://commandcode.ai/models React Router loader reference table.
- `provider-models.json`: https://api.commandcode.ai/provider/v1/models public JSON.
- `go.html`, `goat.html`, `pro.html`: exact `planScope.modelIds` from `/docs/plans/*`.
- `pricing.html`: subscription tables and `planAllowanceUsd` from https://commandcode.ai/docs/resources/pricing-limits.
- `max.html`: every-model and extra-credit eligibility statements from https://commandcode.ai/docs/plans/max.
- `provider.html`: API eligibility and exact Systemone curl request from https://commandcode.ai/docs/provider.
- `provider-systemone.html`: the same captured example after an original React UTF-8 length-prefixed text frame.

Next.js fixtures split the captured JSON record across two script chunks to
exercise the actual framing instead of parsing rendered model names.
