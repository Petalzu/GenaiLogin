# Reference Pricing

Verified on 2026-10-08. These are public API reference estimates, not GENAI bills.
Rates are frozen locally; no pricing network requests run inside the extension.
Existing historical costs are never recalculated on activation.

Prices below are USD per million tokens, in input / cached input / output order.

- gemma-4-31B-it: 0.09 / 0.05 / 0.34.
- gpt-oss-120b: 0.037 / ordinary input rate / 0.17.
- Qwen3.8-27B: 0.425 / 0.085 / 2.55.
- Qwen3.5-397B-A17B: 0.45 / 0.22 / 3.
- GLM-5.3-Flash: 0.15 / 0.03 / 0.5.

Source: https://openrouter.ai/api/v1/models (exact non-batch, non-free model entries).
Individual source URLs are stored in model-pricing.json. OpenRouter reference
prices can vary by provider. Cache creation/storage and other non-token fees
are excluded; the bridge only records input, cached input and output tokens.

GLM-OCR: input and output CNY 0.2 per million tokens, without cache discount.
Source: https://docs.bigmodel.cn/cn/guide/start/pricing
Converted using 1 USD = 6.711932 CNY, snapshot dated 2026-10-07 from
https://open.er-api.com/v6/latest/USD (ExchangeRate-API).

DeepSeek-V4.1-Flash retains its existing official reference rates:
off-peak 0.15 / 0.003 / 0.6; peak rates are twice those values.
DeepSeek-V4.1-Flash-1017 uses the same rates and peak schedule.
Source: https://api-docs.deepseek.com/quick_start/pricing
The existing estimator uses weekday UTC 01:00-04:00 and 06:00-10:00 peaks.
It does not implement the official Chinese public holiday exception.
Requests without a usable start time use off-peak rates, not a price range.

Dashboard token totals and model input/output usage are displayed in millions
(M); stored token counts remain unchanged. Historical estimated USD totals sum
the priced model entries; unpriced usage is excluded, not assumed to be free.

Missing or invalid cached token counts retain the user-selected 90% fallback.
Models without an exact pricing entry are not priced. Missing token usage is
not invented. New completed requests accumulate into the existing single summary.