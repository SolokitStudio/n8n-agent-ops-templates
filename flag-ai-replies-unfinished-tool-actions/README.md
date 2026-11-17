# Flag AI replies in Slack when tool actions did not finish

An n8n workflow that compares an AI agent's final reply with the tool results from the same run, then posts unsupported claims to Slack and returns a verdict the calling workflow can branch on.

No AI key is required. The check is a Code node you can inspect.

Also in the official n8n template library: [Flag unsupported AI agent actions with Slack alerts and Google Sheets logs](https://n8n.io/workflows/22987-flag-unsupported-ai-agent-actions-with-slack-alerts-and-google-sheets-logs/).

Version 1.2.0. Workflow file: [flag-ai-replies-unfinished-tool-actions.json](flag-ai-replies-unfinished-tool-actions.json)

Support and updates: [solokit33.gumroad.com/l/n8n-agent-claim-check](https://solokit33.gumroad.com/l/n8n-agent-claim-check)

Grading saved runs in bulk for a client report: [Agent Claim Audit ($19)](https://solokit33.gumroad.com/l/agent-claim-audit), an offline HTML and CSV report built on this same grader.

## What it does

1. A **Webhook** at `POST /webhook/say-do-check` receives the agent's final `reply` plus either a `calls` tool log, or a saved n8n `execution` and a `nodeMap`.
2. **Config** holds the Slack Incoming Webhook URL, spreadsheet ID, sheet name, when to notify (`gaps`, `stop_ship` or `always`), a source label, a default node map, and `failureMarkers`.
3. **Check Claims** finds completed action claims such as sent, refunded, booked, deleted or all set, including passive and noun phrasing such as "your refund has been processed", "the money is back on your card", "invite is out" and "got the refund issued". If the payload (or a JSON reply) includes an `actions` or `actionsDone` array such as `[{"action":"refund","status":"done"}]`, those structured claims are graded against the tool log and the verb list stays as a backstop. It grades each tool result: an error or timeout is S1, a run with no provider id is S2, a finished result with an id is S3, a later delivery check is S4. An HTTP 200 body that reports failure (for example `ok: false`, `success: false`, `status: error` or `failed`, a present `error` field, or a nonempty `errors` list) is graded F, not finished. A claim needs S3 unless the wording is delivered, confirmed or verified (S4). Future tense and negated wording are not treated as claims.
4. **Respond with Verdict** returns JSON: `pass`, `review` or `stop_ship`. Unsupported pay or delete claims are always `stop_ship`.
5. When `notifyOn` matches, **Post Gaps to Slack** sends the findings through a Slack Incoming Webhook (no Slack app credential is needed).
6. **Append to Google Sheet** writes one row per check.

Call this webhook from the workflow that runs your agent, after the agent node finishes, and hold any outbound send when the verdict is `review` or `stop_ship`.

## What only ours does

This check reads the agent's finished reply for completed action claims, grades each tool result from the same run, and holds or flags a message when the wording is not supported, including a hard stop-ship on unsupported pay or delete claims. No AI key.

Closest templates already in the n8n library, and how this one differs:

1. [Log, audit and escalate AI agent tool calls with Groq, Discord and data tables](https://n8n.io/workflows/18959-log-audit-and-escalate-ai-agent-tool-calls-with-groq-discord-and-data-tables/). It flags *numbers* in the final answer that do not appear in the question or tool I/O. It does not grade whether a claimed action (sent, refunded, booked, deleted) actually finished, and it does not stop-ship a payment claim. It needs Groq.
2. [Detect silent refund reply failures with OpenRouter and webhook logs](https://n8n.io/workflows/20343-detect-silent-refund-reply-failures-with-openrouter-and-webhook-logs/). It routes incomplete order lookups to a person before a refund reply is drafted. It does not compare the agent's finished claims with tool node outcomes in the same run. It needs OpenRouter.
3. [Gate AI answers against source docs with Groq and n8n data tables](https://n8n.io/workflows/18728-gate-ai-answers-against-source-docs-with-groq-and-n8n-data-tables/). It is an LLM judge of prose against source documents, plus number and URL checks. It is not a grade of tool execution status. It needs Groq.

The Code node is a port of the open source [Say-Do Diff](https://github.com/SolokitStudio/say-do-diff) checker and its n8n adapter.

## Setup

1. Import [flag-ai-replies-unfinished-tool-actions.json](flag-ai-replies-unfinished-tool-actions.json) into n8n.
2. In **Config**, set `slackWebhookUrl`, `spreadsheetId`, `sheetName`, `notifyOn`, `sourceLabel`, and, if you send n8n executions, `defaultNodeMap`. Edit `failureMarkers` if your APIs use other fields to mean a call did not finish. An empty list turns off body checks; HTTP 4xx or 5xx and a failed status string still count.
3. Connect Google Sheets OAuth2 on **Append to Google Sheet**.
4. Add this header row to the sheet tab: `timestamp, receivedAt, source, verdict, stopShip, claims, gaps, gapRate, reply, report`.
5. Activate the workflow, POST a test payload to `/webhook/say-do-check`, then check the JSON response and, for a gap case, the Slack message and the new sheet row.

Sample payload (flat tool log):

```json
{
  "reply": "I sent the proposal to dana@acme.com and booked the demo.",
  "calls": [
    {"tool": "gmail.send", "action": "send", "target": "dana@acme.com", "status": "done", "id": "18c2f0a9"},
    {"tool": "gcal.create", "action": "book", "target": "Dana demo Tuesday", "status": "done", "id": "evt_5521"}
  ]
}
```

A tool result with HTTP 200 and a body such as `{"ok": false}` is a gap, not a pass.

You can also send a structured actions list. The verb list still runs on the reply text as a backstop:

```json
{
  "reply": "All set!",
  "actions": [
    {"action": "refund", "status": "done", "target": "order 88412", "amount": 45}
  ],
  "calls": [
    {"tool": "stripe.refund", "action": "pay", "target": "order 88412", "amount": 45, "status": "done", "id": "re_1"}
  ]
}
```

You can also POST a saved n8n execution (`GET /api/v1/executions/<id>?includeData=true`) plus a `nodeMap`. A default map is in Config.

## Tested on

n8n 2.46.6 self hosted. The exact JSON was imported into a fresh, empty database with no errors. A test copy with the Slack URL pointed at a local mock and Google Sheets disabled ran these cases on 2026-11-13:

- Official Say-Do Diff sample execution (send and book succeed, refund times out, the reply claims all three plus "All set!"): HTTP 200, `verdict=stop_ship`, 2 of 4 claims, Slack mock received a stop-ship post.
- Supported send and book only: HTTP 200, `verdict=pass`, 0 gaps, no Slack post.
- Missing `reply`: HTTP 500, documented error, execution status `error`.
- Future tense only ("I will send the report tomorrow..."): HTTP 200, `verdict=pass`, 0 claims, no Slack post.
- "I deleted the old account" with no tool call: HTTP 200, `verdict=stop_ship`, Slack mock received a second stop-ship post.

On 2026-11-14 the Code node was rerun outside n8n (the local n8n instance was not running). Existing cases still passed, including the official sample execution (2 gaps, stop-ship) and a cross-check against the Python Say-Do Diff tests. New cases also passed:

- HTTP 200 with `{ok:false}`, `{success:false}`, `{status:'error'}`, `{status:'failed'}`, a present `error` field, or a nonempty `errors` list: graded F, not finished. A refund claim with `{success:false}` is `stop_ship`.
- HTTP 200 with `{ok:true}`, `{error:null}`, or `errors: []`, plus an id: still S3 (finished).
- Mapping an n8n execution whose HTTP node returned 200 and `{ok:false, id:'re_1'}`: status set to error, refund claim is `stop_ship`.
- Custom `failureMarkers` (including an empty list) override the default list as documented.
- A top-level tool-log `error` such as a timeout stays S1, same as before.

Not run: real Slack delivery, real Google Sheets append, a live agent workflow calling this webhook. The 2026-11-13 webhook cases were not repeated on a live n8n process on 2026-11-14.

On 2026-11-15 the Code node was rerun outside n8n (the local n8n instance was not running). Existing cases still passed, including the official sample execution (2 gaps, stop-ship), the HTTP 200 body-failure cases, and a cross-check against the Python Say-Do Diff tests. New cases also passed:

- "Your refund has been processed", "The money is back on your card", "Done, invite is out" and "I went ahead and got the refund issued" now extract a claim. "The order was cancelled" and "an email has been sent" already did. A processed refund with no tool call is `stop_ship`. Negated or future forms extract no claim.
- An `actions` array such as `[{"action":"refund","status":"done"}]` is graded against the tool log. A timeout is `stop_ship`. A finished pay with an id is `pass`. A JSON reply of `{"text":"All set!","actions":[...]}` uses "All set!" as the displayed reply. The verb list still catches other claims in the text, and the same refund in both places is counted once.
- Action aliases such as refund, email and cancel map to the same actions as the tool log. A structured `email` claim with status `delivered` needs S4.

The 2026-11-13 webhook cases were not repeated on a live n8n process on 2026-11-15.

## Limitations

- This checks a finished reply. It does not recall a message that already went out. Run it before you send.
- Targets are only as good as the tool log or node map. n8n often does not store a resolved recipient, so `target_value` is sometimes a fixed string.
- Only the first output item of each node run is read.
- Replies with no completed action claims pass, including future tense such as "I will send it", unless a structured `actions` list is present.
- The verb list still misses some phrasings. Version 1.2.0 covers the passive and noun cases above; unusual wording can still pass quietly unless you send a structured actions array.
- Anyone who can POST to the webhook can run a check. Keep the URL private or put the workflow behind authentication.
- An invalid payload (missing reply, or no calls and no execution) stops the run with an error before a webhook response is sent.
- If Slack or Sheets fails after the verdict has already been returned, the caller still has the JSON result but the notify or log step may be missing.
- No duplicate check across requests. The same payload posted twice is checked twice.
- Unusual API bodies may need the `failureMarkers` list in Config edited. An empty list turns off body checks.

## Changelog

### 1.2.0 (2026-11-15, PT)

A commenter on r/n8n asked how claims are parsed without an LLM and whether regex holds up. Local checks confirmed silent misses on "Your refund has been processed", "The money is back on your card", "Done, invite is out" and "I went ahead and got the refund issued". The check now extracts those phrasings (and already caught "the order was cancelled" and "an email has been sent"). It also accepts an optional `actions` or `actionsDone` array (for example `[{"action":"refund","status":"done"}]`), including when that list is inside a JSON reply, and grades those structured claims against the tool log. The verb list stays as a backstop. Synonyms such as refund, email and cancel are mapped to the same actions as the tool log. No AI key is required.

### 1.1.0 (2026-11-14, PT)

A commenter on r/n8n pointed out that a tool result with HTTP 200 and a body such as `{ok:false}`, `{success:false}`, `{status:'error'}` or `{status:'failed'}`, a present `error` field, or an `errors` array was graded as finished. The check now treats those as not finished. The marker list lives in Config (`failureMarkers`) so you can add the fields your APIs use. No AI key is required.

### 1.0.0 (2026-11-13, PT)

First public release.

## License

MIT. See [LICENSE](../LICENSE). Copyright 2026 Solokit Studio.
