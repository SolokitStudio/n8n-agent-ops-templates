# n8n agent ops templates

Two n8n workflows from [Solokit Studio](https://github.com/SolokitStudio) for people who run AI agents and who price automation work for clients.

| Template | What it does | Workflow JSON |
|---|---|---|
| [Flag AI replies when tool actions did not finish](flag-ai-replies-unfinished-tool-actions/README.md) | Checks an agent's final reply against the tool results from the same run. Unsupported claims such as sent, refunded, booked or deleted go to Slack, and the caller gets a pass, review or stop-ship verdict. | [flag-ai-replies-unfinished-tool-actions.json](flag-ai-replies-unfinished-tool-actions/flag-ai-replies-unfinished-tool-actions.json) |
| [Email an ROI estimate and price range from a request form](automation-roi-estimate-form/README.md) | Turns a request form into hours and value saved, a suggested pilot price, a payback check that can fail honestly, retainer options, an email and a Google Sheet row. | [automation-roi-estimate-form.json](automation-roi-estimate-form/automation-roi-estimate-form.json) |

Both are standard n8n JSON. Import them, fill the Config node, and connect the named credentials. No community nodes. No AI key is required.

The claim check is also published in the official n8n template library: [Flag unsupported AI agent actions with Slack alerts and Google Sheets logs](https://n8n.io/workflows/22987-flag-unsupported-ai-agent-actions-with-slack-alerts-and-google-sheets-logs/).

A third, related workflow (approve a lead reply in Slack before Gmail sends it) lives in its own repo: [n8n-human-in-the-loop-reply](https://github.com/SolokitStudio/n8n-human-in-the-loop-reply). It is also published in the official n8n template library: [Approve lead reply emails in Slack with Gmail and Google Sheets](https://n8n.io/workflows/22837-approve-lead-reply-emails-in-slack-with-gmail-and-google-sheets/).

## Import

1. Open the folder for the template you want and download the `.json` file.
2. In n8n, go to Workflows, add a workflow, then Import from File (or paste the JSON onto the canvas).
3. Follow the Setup section in that template's README.

## Support and updates

These workflows are free to use under the MIT license in this repo. If you want a packaged copy, a place to ask questions, or to hear when a revision ships, use the product pages below. They are pay what you want, including $0.

- Claim check template: [solokit33.gumroad.com/l/n8n-agent-claim-check](https://solokit33.gumroad.com/l/n8n-agent-claim-check)
- ROI estimate form: [solokit33.gumroad.com/l/n8n-roi-estimate-form](https://solokit33.gumroad.com/l/n8n-roi-estimate-form)

## Audit runs you already have

The claim check grades one reply as it happens. To grade a folder of saved n8n executions after the fact and get a printable HTML report plus a CSV of every claim, there is a paid offline kit built on the same grader, no AI key: [Agent Claim Audit ($19)](https://solokit33.gumroad.com/l/agent-claim-audit).

## Tested on

Both templates were imported into a fresh n8n 2.46.6 self hosted instance and run with mocks. The exact cases and the steps that were not run are listed in each template README.

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 Solokit Studio.
