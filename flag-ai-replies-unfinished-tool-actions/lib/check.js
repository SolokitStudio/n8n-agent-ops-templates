#!/usr/bin/env node
/**
 * Grade one payload file outside n8n, with the same code as the Check Claims node.
 *
 *   node check.js payload.json          prints the text report
 *   node check.js payload.json --json   prints the full JSON result
 *   cat payload.json | node check.js -
 *
 * The payload is the same body the webhook takes: {"reply", "calls"} or
 * {"execution", "nodeMap"}, plus optional "actions", "replyTarget",
 * "failureMarkers" and "partialRules".
 * Exit code: 0 pass, 1 review, 2 stop_ship, 3 bad input.
 */
'use strict';
const fs = require('fs');
const { checkPayload } = require('./saydo_check');

const args = process.argv.slice(2);
const file = args.find((a) => a !== '--json');
if (!file) {
  console.error('usage: node check.js <payload.json | -> [--json]');
  process.exit(3);
}
try {
  const text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  const out = checkPayload(text, null);
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else console.log(`verdict: ${out.verdict}\n\n${out.report}`);
  process.exit({ pass: 0, review: 1, stop_ship: 2 }[out.verdict]);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(3);
}
