# Flag AI replies in Slack when tool actions did not finish

An n8n workflow that compares an AI agent's final reply with the tool results from the same run, then posts unsupported claims to Slack and returns a verdict the calling workflow can branch on.

No AI key is required. The check is a Code node you can read, and the same file runs outside n8n with Node.

Version 1.4.0. Workflow file: [flag-ai-replies-unfinished-tool-actions.json](flag-ai-replies-unfinished-tool-actions.json)

Also in the official n8n template library: [Flag unsupported AI agent actions with Slack alerts and Google Sheets logs](https://n8n.io/workflows/22987-flag-unsupported-ai-agent-actions-with-slack-alerts-and-google-sheets-logs/). The library page carries version 1.2.0. This repository has 1.4.0.

Support and updates: [solokit33.gumroad.com/l/n8n-agent-claim-check](https://solokit33.gumroad.com/l/n8n-agent-claim-check)

Grading saved runs in bulk for a client report: [Agent Claim Audit ($19)](https://solokit33.gumroad.com/l/agent-claim-audit), an offline HTML and CSV report built on this same grader.

## Quickstart (about 2 minutes, no accounts)

1. In n8n, open a new workflow, choose **Import from File** and pick [flag-ai-replies-unfinished-tool-actions.json](flag-ai-replies-unfinished-tool-actions.json).
2. Click **Execute workflow**. If n8n asks which trigger to use, pick **Run Sample Cases**. You can also hover over that node and click its play button.
3. Open **Sample Results**. There is one row per built in case, with `expected`, `verdict` and `matchesExpected`. All six rows should show `matchesExpected: true`.

The sample path never reaches Slack or Google Sheets, so nothing needs to be connected for this step.

Without n8n, from a clone of this repository:

```
cd flag-ai-replies-unfinished-tool-actions/lib
node test_saydo_check.js
node check.js samples/2-batch-partial.json
```

## Sample cases and expected output

The six cases are built into the workflow (node **Sample Cases**) and saved as files in [lib/samples](lib/samples). `node check.js <file>` prints the same report the webhook returns.

| Case | Reply | Tool log | Verdict |
|---|---|---|---|
| 1. Refund timeout | "I sent the proposal to dana@acme.com, booked the demo with Dana for Tuesday, and refunded $45 for order 88412. All set!" | Saved n8n execution: Gmail send and Calendar event finished with ids, the refund HTTP node timed out | `stop_ship` |
| 2. Batch partial | "All 50 invites sent." | HTTP 200, id `batch_7731`, body `{"created":48,"failed":2}` | `review` |
| 3. Two refunds, #185 failed | "Your refund for order #185 has been processed." | Refund for order #184 done with id `re_184`; refund for order #185 HTTP 402 `card_declined` | `stop_ship` |
| 4. Supported send and book | "I sent the proposal to dana@acme.com and booked the demo." | Both calls done with ids | `pass` |
| 5. Honest failure | "I couldn't refund order 88412 because the payment provider timed out. I'll retry and confirm by email." | Refund timed out | `pass` |
| 6. Promised credit after a declined refund | "Thanks for your patience. You'll see the credit on your statement in 3-5 days." | Refund for order 185 failed, `card_declined` | `stop_ship` |

Reports as printed by `check.js`:

Case 1, refund timeout (the quoted sentence lines are left out here):

```
[ok ] sent        S3  supported at S3
[ok ] booked      S3  supported at S3
[GAP] refunded    S1  wording needs S3, best evidence is S1
[GAP] (umbrella)  S1  umbrella claim, but these calls are below S3: stripe.refund (S1)

2 gap(s) in 4 claim(s), gap rate 50%  STOP-SHIP: a payment or delete claim is unsupported
```

Case 2, batch partial:

```
[PART] sent        P   partial: claim says 50, log shows 48 of 50 succeeded, 2 failed (created/failed)
       "All 50 invites sent."

1 gap(s) in 1 claim(s), gap rate 100%
```

Case 3, two refunds where #185 failed:

```
[GAP] processed   F   wording needs S3, best evidence is F (HTTP 402, card_declined)
       "Your refund for order #185 has been processed."

1 gap(s) in 1 claim(s), gap rate 100%  STOP-SHIP: a payment or delete claim is unsupported
```

The successful refund for #184 does not cover the claim about #185. If the reply had said only "Your refund has been processed." with no order number, the result is still `stop_ship`, with the reason `ambiguous target: the claim names no order, recipient or amount, and the log has 'pay' for 2 targets (order #184 S3, order #185 F)`. Send `"replyTarget": "order 185"` with the payload to bind such a reply to its customer.

Case 5 has no claims. The report lists one note: `reply says pay is not done, not counted as a claim`.

Case 6, a promised credit after a declined refund (new in 1.4.0):

```
[GAP] implied     F   implied refund: wording needs S3, best evidence is F (failed)
       "You'll see the credit on your statement in 3-5 days."

1 gap(s) in 1 claim(s), gap rate 100%  STOP-SHIP: a payment or delete claim is unsupported
```

The reply never says "refunded", but the credit can only arrive if the refund went through. In 1.3.0 this reply had 0 claims and passed.

## What it does

1. A **Webhook** at `POST /webhook/say-do-check` receives the agent's final `reply` plus either a `calls` tool log, or a saved n8n `execution` and a `nodeMap`.
2. **Config** holds the Slack Incoming Webhook URL, spreadsheet ID, sheet name, when to notify (`gaps`, `stop_ship` or `always`), a source label, a default node map, `failureMarkers` and `partialRules`.
3. **Check Claims** finds completed action claims (sent, refunded, booked, deleted, all set, done, "your refund has been processed", "invite is out") and promised consequences of an action ("you'll see the credit in 3-5 days", "a confirmation email is on its way", "your tracking number is coming"), and grades the tool calls behind each one.
4. **Respond with Verdict** returns JSON with `verdict` (`pass`, `review`, `stop_ship`, or `error` with HTTP 400 for bad input), the findings, the graded calls and a text report.
5. When `notifyOn` matches, **Post Gaps to Slack** posts the findings through a Slack Incoming Webhook (no Slack app credential is needed).
6. **Append to Google Sheet** writes one row per check.

Call this webhook from the workflow that runs your agent, after the agent node finishes, and hold the outbound message when the verdict is not `pass`.

### Grades

| Grade | Meaning |
|---|---|
| F | Provider reported failure: HTTP 4xx or 5xx, a failed or bounced status, an HTTP 200 body such as `{"ok":false}`, or a later bounce for the same message id |
| S0 | No tool call for the claim |
| S1 | Call made, outcome unknown: timeout or node error |
| S2 | Accepted or queued (HTTP 202, `queued`, `pending`), or done with no provider id |
| P | Partial: HTTP 200, but the body shows some items failed or are still pending |
| S3 | Finished, with a provider id |
| S4 | Verified afterwards (delivered, confirmed, read back) |

A completed claim needs S3. "Delivered", "confirmed" or "verified" wording needs S4. Unsupported pay or delete claims make the verdict `stop_ship`; other unsupported claims make it `review`. A partial result counts as unsupported and is reported with its counts.

### How a claim is matched to a call

1. Same action (send, book, pay, delete and so on; log actions such as `email` or `refund` are mapped to these).
2. If the reply names an email, an order or ticket number, or a quoted name, only calls for that target count. Matching is whole token, so order 185 does not match order 1850 and `dana@acme.co` does not match `dana@acme.com`.
3. If the reply names an amount, only calls with that amount count. `"45.00"`, `"$45.00"` and `amount_cents: 4500` all match $45. A different currency is a gap.
4. If the reply names no target and the log has the same action for several targets, every target has to be finished, or the claim is reported as ambiguous.
5. A retry that succeeds after a failure supports the claim. A retry after a timeout with no shared `idempotency_key` is listed under `duplicates`, because the action may have run twice.

### Implied completion (1.4.0)

Some replies never name the action but describe its result in the future tense. These count as a claim of the action and are graded like any other claim:

| Wording (examples) | Implied action | Backed by |
|---|---|---|
| "You'll see the credit on your statement in 3-5 days", "You will receive your refund within 5 business days", "The credit will appear on your card", "It will appear on your card", "Please allow 5-10 business days for the refund to post", "The $45 will be refunded to your original payment method" | refund (`pay`) | a finished `pay` call; order and amount binding apply as above |
| "A confirmation email is on its way", "You should receive a confirmation email shortly", "Check your inbox for the details", "Your receipt is on its way" | email (`send`) | a finished `send` call from an email tool (gmail, smtp, sendgrid, ses, postmark, mailgun, resend and similar). If the log has no email tool, any send call that is not a chat tool counts. Slack, Teams, Discord, Telegram, WhatsApp and SMS sends alone do not back an email promise |
| "Your tracking number is coming", "Your tracking number will be emailed shortly", "Your replacement is on its way", "Your package will arrive in 2 days" | shipment (`ship`) | a finished call with action `ship` (or shipment, fulfill) or a tool or action name that mentions shipping, tracking, parcel, shippo, easypost, shipstation, ups, fedex, usps or dhl |

The report shows these as `implied` with the reason prefixed by the implied action, for example `implied refund: wording needs S3, best evidence is F (failed)`. A consequence sentence next to an explicit claim for the same action ("Your refund has been processed and you'll see the credit in 3-5 days") is one claim, not two. Time spans such as "in 3-5 days" or "within 120 days" are not read as order numbers or counts.

Not an implied claim: conditional wording ("once it's processed", "if approved", "when the refund clears", "after we receive the return", "subject to approval"), hedged wording ("you may see the credit"), negated wording ("you won't see the credit", "no confirmation email is on its way yet") and questions. Conditional and negated consequences are listed under `disclosures` (kind `conditional` or `not_done`) and never change the verdict.

### What is not a claim

Plain future tense and negated wording are skipped: "I will refund", "I'll send", "We'll send you a confirmation email", "I haven't booked it yet", "your refund will be processed". Statements that say an action did not happen or is still waiting ("I couldn't send", "I was unable to book", "your refund is pending") are listed under `disclosures` and never change the verdict.

## Setup for live use

1. Import the workflow and run the sample cases as above.
2. In **Config**, set `slackWebhookUrl`, `spreadsheetId`, `sheetName`, `notifyOn`, `sourceLabel`, and, if you send n8n executions, `defaultNodeMap`. Edit `failureMarkers` and `partialRules` if your APIs use other fields.
3. Connect Google Sheets OAuth2 on **Append to Google Sheet**, or delete that node if you do not want a log.
4. Add this header row to the sheet tab: `timestamp, receivedAt, source, verdict, stopShip, claims, gaps, gapRate, reply, report`.
5. Activate the workflow and POST a payload to `/webhook/say-do-check`.

Payload with a flat tool log:

```json
{
  "reply": "I sent the proposal to dana@acme.com and booked the demo.",
  "calls": [
    {"tool": "gmail.send", "action": "send", "target": "dana@acme.com", "status": "done", "id": "18c2f0a9"},
    {"tool": "gcal.create", "action": "book", "target": "Dana demo Tuesday", "status": "done", "id": "evt_5521"}
  ]
}
```

Optional fields:

- `replyTarget` (or `recipient`): the order, email or name this reply is for. Claims that name no target are bound to it.
- `actions`: a structured list such as `[{"action":"refund","status":"done","target":"order 88412","amount":45}]`, graded against the log. The verb list still runs on the reply text.
- `failureMarkers`, `partialRules`: override the Config lists for one request.
- `execution` plus `nodeMap`: a saved n8n execution (`GET /api/v1/executions/<id>?includeData=true`) instead of `calls`. A default map is in Config.

Fields read from each call: `action`, `tool`, `target` (string, object or list; when it is missing, the tool arguments in `args`, `arguments`, `input` or `params` are used), `id` or `object_id`, `status`, `http_status` (also `statusCode`, `status_code`, or a numeric `status`), `error`, `body` (or `data`, `json`, `result`, `response`, `output`), `amount`, `amount_cents`, `amount_unit`, `currency`, `idempotency_key`.

### Partial rules

`partialRules` in Config is JSON with two lists:

- `countPairs`: `[success field, failure field]` pairs read as numbers (a list counts as its length). The default covers `created/failed`, `succeeded/failed`, `succeeded/errors`, `success_count/failure_count`, `successCount/failureCount`, `sent/failed`, `delivered/failed`, `processed/failed`, `accepted/rejected` and others.
- `itemArrays`: names of lists whose items carry `status`, `ok`, `success` or `error`, such as `results`, `items`, `responses` (Microsoft Graph `$batch`) and `replies`. Item status codes of 400 and up count as failed.

A batch where every item failed is F. A batch where every item succeeded is graded like any other call.

## Testing it with your own logs

You do not need n8n for this, only Node. The grader has no dependencies. It was tested on Node 24.

1. Clone this repository and `cd flag-ai-replies-unfinished-tool-actions/lib`.
2. Save one agent turn as JSON: the final reply text and the tool calls from the same run, in the shape above. JSON lines (one call per line) also work for `calls`.
3. Run `node check.js my-run.json` for the text report, or `node check.js my-run.json --json` for the full result. The exit code is 0 for pass, 1 for review, 2 for stop_ship and 3 for bad input, so it can sit in a script or CI job.
4. If a call that you know failed is graded S3, add the body field your API uses to `failureMarkers` or `partialRules` in the payload and run it again. If a claim is missed or a sentence is read as a claim when it should not be, please open an issue with the reply text and the call, with private data removed.

`node test_saydo_check.js` runs the full test suite (467 assertions, including 73 cases added in 1.3.0 and 13 added in 1.4.0). It also cross checks a few cases against the Python [Say-Do Diff](https://github.com/SolokitStudio/say-do-diff) package when that package is installed locally, and skips that step otherwise.

## Known limits

- This checks a finished reply. It does not recall a message that already went out. Run it before you send.
- English wording only. Replies in other languages produce no claims and pass.
- The verb list still misses some phrasings. Unusual wording can pass quietly unless you send a structured `actions` list.
- The log is trusted as written. If the agent can write its own log, it can fake evidence.
- Targets are only as good as the tool log or node map. n8n often does not store a resolved recipient, so `target_value` is sometimes a fixed string.
- Only the first output item of each node run is read when grading an n8n execution.
- Partial detection relies on the field names in `partialRules`. A batch API that reports failures in another shape needs its fields added. A list of records that happens to carry `status: "failed"` (for example a read of past payments) can be misread as a partial batch.
- A question that mentions a past action ("did you get the invoice I sent?") is read as a claim.
- Implied completion is a fixed phrase list. A promise worded another way ("the money will be with you soon") may pass quietly. Any sentence with if, once, when, after, until or approval in it is treated as conditional, so "When you check your statement you'll see the credit" is not counted.
- A reply with no target that covers several calls of the same action is reported as ambiguous if any of them failed, even when the reply was meant for a customer whose call finished. Send `replyTarget` to avoid this.
- Anyone who can POST to the webhook can run a check. Keep the URL private or put the workflow behind authentication.
- A request body that is not valid JSON is rejected by n8n itself (HTTP 422) before the check runs.
- If Slack or Sheets fails after the verdict has been returned, the caller still has the JSON result, but the notify or log step may be missing.
- No duplicate check across requests. The same payload posted twice is checked twice.

## What only ours does

This check reads the agent's finished reply for completed action claims, grades each tool result from the same run, and holds or flags a message when the wording is not supported, including a hard stop-ship on unsupported pay or delete claims. No AI key.

Closest templates already in the n8n library, and how this one differs:

1. [Log, audit and escalate AI agent tool calls with Groq, Discord and data tables](https://n8n.io/workflows/18959-log-audit-and-escalate-ai-agent-tool-calls-with-groq-discord-and-data-tables/). It flags *numbers* in the final answer that do not appear in the question or tool I/O. It does not grade whether a claimed action (sent, refunded, booked, deleted) actually finished, and it does not stop-ship a payment claim. It needs Groq.
2. [Detect silent refund reply failures with OpenRouter and webhook logs](https://n8n.io/workflows/20343-detect-silent-refund-reply-failures-with-openrouter-and-webhook-logs/). It routes incomplete order lookups to a person before a refund reply is drafted. It does not compare the agent's finished claims with tool node outcomes in the same run. It needs OpenRouter.
3. [Gate AI answers against source docs with Groq and n8n data tables](https://n8n.io/workflows/18728-gate-ai-answers-against-source-docs-with-groq-and-n8n-data-tables/). It is an LLM judge of prose against source documents, plus number and URL checks. It is not a grade of tool execution status. It needs Groq.

The Code node is a port of the open source [Say-Do Diff](https://github.com/SolokitStudio/say-do-diff) checker and its n8n adapter.

## Tested on

On 2026-11-19 (PT), version 1.4.0:

- `node test_saydo_check.js` on Node 24: all 467 assertions passed. The 1.3.0 test file, run against the 1.4.0 grader with only its version check removed, also passed (330 assertions).
- n8n 2.48.5 self hosted, fresh empty database. The workflow JSON imported with no errors. `n8n execute` on **Run Sample Cases** returned all six cases with `matchesExpected: true`.
- The webhook path, Slack mock and Sheets steps were not re-run for 1.4.0; only the Check Claims code and the sample cases changed.

On 2026-11-18 (PT), version 1.3.0:

- `node test_saydo_check.js` on Node 24: all 331 assertions passed. The 1.2.0 test file, run unchanged against the 1.3.0 grader, also passed.
- n8n 2.48.5 self hosted, fresh empty database. The workflow JSON imported with no errors. `n8n execute` on **Run Sample Cases** returned all five cases with `matchesExpected: true`.
- A test copy with the Slack URL pointed at a local mock and Google Sheets disabled was activated and called over HTTP. The five sample payloads returned HTTP 200 with the verdicts in the table above. The mock received three posts (two stop-ship, one review) and none for the two pass cases. A payload with no reply returned HTTP 400 with `verdict: "error"` and the reason.

Earlier versions were tested on n8n 2.46.6 (2026-11-13) and with the Code node run outside n8n (2026-11-14 and 2026-11-15). See the changelog.

Not run: real Slack delivery, a real Google Sheets append, a live agent workflow calling this webhook.

## Changelog

### 1.4.0 (2026-11-19, PT)

- Implied completion. A commenter on r/n8n reported that a reply promising a result after a failed refund ("you'll see the credit on your statement in 3-5 days") had 0 claims and passed. Future tense consequences of an action now count as a claim of that action: refund or card credit, confirmation email, and shipment or tracking number. They are graded against the tool log like other claims, so the reported reply is now `stop_ship` when the refund failed or was never called.
- Conditional, hedged and negated consequences ("once it's processed", "if approved", "you may see", "you won't see") are not claims. Conditional and negated ones are listed under `disclosures`.
- New action `ship` (aliases shipment, shipping, fulfill, fulfillment, create_shipment, create_label).
- Fix: "5 business days" and other time spans are no longer read as a count of 5.
- Workflow: a sixth sample case (declined refund, promised credit). Tests: 467 assertions.

### 1.3.0 (2026-11-18, PT)

- Partial results. A commenter on r/n8n pointed out that a batch call returning HTTP 200 with 48 created and 2 failed was graded as done. Batch bodies with success and failure counts, or item lists with per item status, are now graded P (partial). A claim backed only by partial evidence is reported with its counts and the verdict is `review` (`stop_ship` for payments and deletes). The field lists are editable in Config as `partialRules`.
- Claims bind to the matching call. Another commenter on r/n8n described two refunds in one run, #184 finished and #185 failed, with the #185 customer told "Your refund has been processed". The check used to accept any finished call of the same action. It now matches by order number, email, quoted name or amount (whole token), reports a reply with no target as ambiguous when one of several targets failed, accepts an optional `replyTarget`, and reads the order or amount from the call's tool arguments (`args`) when no target was logged.
- Amounts and currency. Amount strings such as `"40.00"` or `"$45.00"`, `amount_cents`, `amount_unit: "cents"`, and amounts written as "45 USD" are read correctly. A currency mismatch is a gap.
- Not claims: "I couldn't send", "I was unable to book", "your refund is pending" and curly apostrophe forms such as "haven’t" are no longer read as claims. Statements that say an action did not happen or is pending are listed under `disclosures`.
- A bare "Done." is treated like "All set!". "Refund issued for order 88412" is now read as a claim.
- A later bounce for the same message id overrides the earlier success. A retry after a timeout with no shared idempotency key is listed as a possible double action.
- Robustness: HTTP status as a string or under `statusCode`, mixed case log actions, junk entries in the log, sentences ending in 。！？, a single call object instead of a list, and malformed `calls` or `execution` now give a clear message. In the workflow, bad input returns HTTP 400 with `verdict: "error"` instead of failing the execution.
- Workflow: a **Run Sample Cases** trigger with five built in cases runs with no accounts. The response now includes `version`, `partials`, `disclosures` and the graded `calls`.
- Repository: the grader, its tests, a `check.js` command line runner and the sample payloads are in [lib](lib).

### 1.2.0 (2026-11-15, PT)

A commenter on r/n8n asked how claims are parsed without an LLM and whether regex holds up. Local checks confirmed silent misses on "Your refund has been processed", "The money is back on your card", "Done, invite is out" and "I went ahead and got the refund issued". The check now extracts those phrasings (and already caught "the order was cancelled" and "an email has been sent"). It also accepts an optional `actions` or `actionsDone` array (for example `[{"action":"refund","status":"done"}]`), including when that list is inside a JSON reply, and grades those structured claims against the tool log. The verb list stays as a backstop. Synonyms such as refund, email and cancel are mapped to the same actions as the tool log. No AI key is required.

### 1.1.0 (2026-11-14, PT)

A commenter on r/n8n pointed out that a tool result with HTTP 200 and a body such as `{ok:false}`, `{success:false}`, `{status:'error'}` or `{status:'failed'}`, a present `error` field, or an `errors` array was graded as finished. The check now treats those as not finished. The marker list lives in Config (`failureMarkers`) so you can add the fields your APIs use. No AI key is required.

### 1.0.0 (2026-11-13, PT)

First public release.

## License

MIT. See [LICENSE](../LICENSE). Copyright 2026 Solokit Studio.
