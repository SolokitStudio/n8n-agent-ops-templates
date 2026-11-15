# Changelog

All notable changes to the templates in this repository.

## Flag AI replies in Slack when tool actions did not finish

### 1.2.0 (2026-11-15, PT)

A commenter on r/n8n asked how claims are parsed without an LLM and whether regex holds up. Local checks confirmed silent misses on "Your refund has been processed", "The money is back on your card", "Done, invite is out" and "I went ahead and got the refund issued". The check now extracts those phrasings (and already caught "the order was cancelled" and "an email has been sent"). It also accepts an optional `actions` or `actionsDone` array (for example `[{"action":"refund","status":"done"}]`), including when that list is inside a JSON reply, and grades those structured claims against the tool log. The verb list stays as a backstop. Synonyms such as refund, email and cancel are mapped to the same actions as the tool log. No AI key is required.

### 1.1.0 (2026-11-14, PT)

A commenter on r/n8n pointed out that a tool result with HTTP 200 and a body such as `{ok:false}`, `{success:false}`, `{status:'error'}` or `{status:'failed'}`, a present `error` field, or an `errors` array was graded as finished. The check now treats those as not finished. The marker list lives in Config (`failureMarkers`) so you can add the fields your APIs use. No AI key is required.

### 1.0.0 (2026-11-13, PT)

First public release.

## Email an ROI estimate and price range from a request form

### 1.0.0 (2026-11-13, PT)

First public release.
