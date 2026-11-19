# Changelog

All notable changes to the templates in this repository.

## Flag AI replies in Slack when tool actions did not finish

### 1.4.0 (2026-11-19, PT)

- Implied completion. A commenter on r/n8n reported that a reply promising a result after a failed refund ("you'll see the credit on your statement in 3-5 days") had 0 claims and passed. Future tense consequences of an action now count as a claim of that action: refund or card credit ("the credit will appear on your card", "you will receive your refund within 5 business days"), confirmation email ("a confirmation email is on its way"), and shipment ("your tracking number is coming"). They are graded against the tool log like other claims, so the reported reply is now `stop_ship` when the refund failed or was never called. An email promise needs an email send; a Slack or other chat send alone does not back it.
- Conditional, hedged and negated consequences ("once it's processed", "if approved", "you may see the credit", "you won't see the credit") are not claims. Conditional and negated ones are listed under `disclosures` with kind `conditional` or `not_done`.
- New action `ship` (aliases shipment, shipping, fulfill, fulfillment, create_shipment, create_label). A call whose tool name mentions shipping or a carrier also backs a shipment claim.
- Fix: "5 business days" and other time spans are no longer read as a count.
- Workflow: a sixth built in sample case (declined refund, promised credit, expected `stop_ship`). Tests: 467 assertions, including 13 new cases.

### 1.3.0 (2026-11-18, PT)

- Partial results. A commenter on r/n8n pointed out that a batch call returning HTTP 200 with 48 created and 2 failed was graded as done. Batch bodies with success and failure counts, or item lists with per item status, are now graded P (partial). A claim backed only by partial evidence is reported with its counts and the verdict is `review` (`stop_ship` for payments and deletes). The field lists are editable in Config as `partialRules`.
- Claims bind to the matching call. Another commenter on r/n8n described two refunds in one run, #184 finished and #185 failed, with the #185 customer told "Your refund has been processed". The check used to accept any finished call of the same action. It now matches by order number, email, quoted name or amount (whole token), reports a reply with no target as ambiguous when one of several targets failed, accepts an optional `replyTarget`, and reads the order or amount from the call's tool arguments (`args`) when no target was logged.
- Amounts and currency. Amount strings such as `"40.00"` or `"$45.00"`, `amount_cents`, `amount_unit: "cents"`, and amounts written as "45 USD" are read correctly. A currency mismatch is a gap.
- Not claims: "I couldn't send", "I was unable to book", "your refund is pending" and curly apostrophe forms such as "haven’t" are no longer read as claims. Statements that say an action did not happen or is pending are listed under `disclosures`.
- A bare "Done." is treated like "All set!". "Refund issued for order 88412" is now read as a claim.
- A later bounce for the same message id overrides the earlier success. A retry after a timeout with no shared idempotency key is listed as a possible double action.
- Robustness: HTTP status as a string or under `statusCode`, mixed case log actions, junk entries in the log, sentences ending in 。！？, a single call object instead of a list, and malformed `calls` or `execution` now give a clear message. In the workflow, bad input returns HTTP 400 with `verdict: "error"` instead of failing the execution.
- Workflow: a **Run Sample Cases** trigger with five built in cases runs with no accounts. The response now includes `version`, `partials`, `disclosures` and the graded `calls`.
- Repository: the grader, its tests, a `check.js` command line runner and the sample payloads are in [lib](flag-ai-replies-unfinished-tool-actions/lib).

### 1.2.0 (2026-11-15, PT)

A commenter on r/n8n asked how claims are parsed without an LLM and whether regex holds up. Local checks confirmed silent misses on "Your refund has been processed", "The money is back on your card", "Done, invite is out" and "I went ahead and got the refund issued". The check now extracts those phrasings (and already caught "the order was cancelled" and "an email has been sent"). It also accepts an optional `actions` or `actionsDone` array (for example `[{"action":"refund","status":"done"}]`), including when that list is inside a JSON reply, and grades those structured claims against the tool log. The verb list stays as a backstop. Synonyms such as refund, email and cancel are mapped to the same actions as the tool log. No AI key is required.

### 1.1.0 (2026-11-14, PT)

A commenter on r/n8n pointed out that a tool result with HTTP 200 and a body such as `{ok:false}`, `{success:false}`, `{status:'error'}` or `{status:'failed'}`, a present `error` field, or an `errors` array was graded as finished. The check now treats those as not finished. The marker list lives in Config (`failureMarkers`) so you can add the fields your APIs use. No AI key is required.

### 1.0.0 (2026-11-13, PT)

First public release.

## Email an ROI estimate and price range from a request form

### 1.0.0 (2026-11-13, PT)

First public release.
