# Email an ROI estimate and price range from a request form

An n8n workflow that turns a request form into an estimate of hours and value saved, a suggested pilot price, a payback check that can fail honestly, monthly retainer options, an email to the prospect, a form ending page and a Google Sheet row.

No AI key is required. The arithmetic is a Code node you can inspect, taken from Solokit Studio's free ROI, pricing and retainer calculator.

Workflow file: [automation-roi-estimate-form.json](automation-roi-estimate-form.json)

Support and updates: [solokit33.gumroad.com/l/n8n-roi-estimate-form](https://solokit33.gumroad.com/l/n8n-roi-estimate-form)

## What it does

1. An **n8n form** at `/form/automation-roi` collects the prospect's name, email, optional company and process, tasks per week, minutes per task today, minutes a person would still spend after automation, hourly cost, and optional other monthly savings.
2. **Config** holds your rates: build hours, hourly rate, risk buffer, tool costs, target payback, deposit share, retainer table, signature, spreadsheet ID and sheet name. The shipped numbers are examples, not a recommended price.
3. **Validate and Estimate** computes hours and value saved, a cost based pilot price rounded up to $50, a value ceiling (monthly value times the target payback), a payback check, a deposit and balance, three monthly retainer tiers (Essentials, Standard, Growth), a flag when a tier takes more than half the client's monthly value, and a first year view.
4. **Send Estimate (Gmail)** emails the range. The email states that the figures are estimates only, not a quote or a guarantee.
5. **Show Estimate on Form** shows the same figures on the form ending page, and says we will also email a copy.
6. **Append to Google Sheet** writes one row per request.

## What only ours does

This workflow applies a fixed, published pricing model to the client's own numbers: hours saved, a cost based pilot rounded up to $50, a value ceiling payback check that will say "shrink the scope" when the price does not pencil, deposit and balance, and three retainer tiers flagged when a tier takes more than half the monthly value. No model invents the savings figures.

Closest templates already in the n8n library, and how this one differs:

1. [Generate Business Automation Opportunities and ROI Reports with Claude AI](https://n8n.io/workflows/9546-generate-business-automation-opportunities-and-roi-reports-with-claude-ai/). A form plus Claude agents that invent opportunities, ROI and a three tier price email. It needs a paid API. This template uses inspectable arithmetic, including an honest fail on payback.
2. [Generate AI sales proposals with Gemini and Google Docs](https://n8n.io/workflows/12715-generate-ai-sales-proposals-with-gemini-and-google-docs/). A form plus a Code node for a generic ROI, then Gemini writes a proposal document. It is not this automation pilot and retainer model (round up to $50 / $25, value ceiling, deposit, "over half of monthly value" flag, first year view).
3. [Send instant price quotes from forms with Data Tables, Telegram and Gmail](https://n8n.io/workflows/21305-send-instant-price-quotes-from-forms-with-data-tables-telegram-and-gmail/). Quotes from a service price list (unit price, discounts, VAT). It is not hours saved, client payback or retainers for an automation build.

## Setup

1. Import [automation-roi-estimate-form.json](automation-roi-estimate-form.json) into n8n.
2. In **Config**, set your build hours, hourly rate, risk buffer, tool costs, target payback, deposit share, retainer rates, signature, spreadsheet ID and sheet name.
3. Connect Gmail OAuth2 on **Send Estimate (Gmail)** and Google Sheets OAuth2 on **Append to Google Sheet**.
4. Add this header row to the sheet tab: `timestamp, receivedAt, name, email, company, process, valuePerMonth, suggestedPilotPrice, paybackCheck, firstYearCost`.
5. Activate the workflow, open `/form/automation-roi`, submit the sample numbers below, and check the ending page, the email and the sheet row.

On n8n 2.6, the form path lives in the Form Trigger's Options, and is shipped as `automation-roi`.

Sample numbers (synthetic, the calculator's worked example): tasks per week 120, minutes today 6, minutes after 1, hourly cost $35. With the shipped Config defaults this produces $1,400 estimated value per month, a suggested pilot price of $1,550, payback about 1.11 months, and the check "OK: within target payback".

## Tested on

n8n 2.46.6 self hosted. The exact JSON was imported into a fresh, empty database with no errors. A test copy with Gmail and Google Sheets disabled ran these form cases on 2026-11-13 (n8n first returns a `formWaitingUrl`; the ending page is then served at that URL):

- Worked example above: ending page "Your estimate is ready", $1,400 per month, $1,550 pilot, 1.11 months, "OK: within target payback", estimates only disclaimer present.
- Low volume so the pilot exceeds the value ceiling: ending page asks the reader to read the payback check, $2.67 per month, $1,550 pilot, 581.25 months, "Over target payback: shrink the scope or confirm the value".
- Bad email: the Code node stopped the run with `Invalid or missing "email"`. n8n showed its generic "Problem loading form" page.
- Minutes after higher than minutes today: $0.00 per month, payback n/a, "Enter the client's numbers above".

The Code node was also checked outside n8n against the spreadsheet formulas (10 hours per week, 40 hours per month, $1,400 value, cost based $1,540, suggested $1,550, retainers $175 / $325 / $575, first year Standard $5,125).

Not run: real Gmail delivery, real Google Sheets append, the retainer "over half of monthly value" flag inside n8n (that flag was unit tested only).

Observed n8n behavior: after a successful estimate, the execution stayed in a waiting state so the ending page could be served at `/form-waiting/<id>`. The estimate had already been computed.

## Limitations

- Results depend entirely on the numbers entered. They are estimates only, not a forecast, guarantee, formal quote, proposal, or financial, tax or legal advice.
- There is no spam filter or duplicate check. The same form posted twice sends two emails and writes two rows.
- If Gmail fails, the form ending may not appear and no sheet row is written for that request.
- The ending page says we will also email a copy. That happens when **Send Estimate (Gmail)** is connected and runs. If you disable that node, edit the ending text.
- An invalid or missing email stops the run. n8n then shows its generic "Problem loading form" page.
- Anyone who can open the public form can submit a request and trigger an email from your Gmail account. Link the form from your own site, or add form authentication.

## License

MIT. See [LICENSE](../LICENSE). Copyright 2026 Solokit Studio.
