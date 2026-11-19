'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  gradeCall, extractClaims, diff, toLog, replyText, checkPayload,
  normalizeFailureMarkers,
} = require('./saydo_check');

function one(message, log) {
  const r = diff(message, log);
  return r.findings[0] || null;
}

// --- Grades (mirrors tests/test_diff.py Grades.test_grade_table)
const gradeCases = [
  [{}, 'S1'],
  [{ error: 'timeout' }, 'S1'],
  [{ status: 'timeout' }, 'S1'],
  [{ http_status: 202 }, 'S2'],
  [{ status: 'queued' }, 'S2'],
  [{ status: 'done' }, 'S2'],
  [{ status: 'done', id: 'm1' }, 'S3'],
  [{ http_status: 200, id: 'm1' }, 'S3'],
  [{ status: 'delivered', id: 'm1' }, 'S4'],
  [{ status: 'bounced' }, 'F'],
  [{ http_status: 500 }, 'F'],
  [{ grade: 's4' }, 'S4'],
];
for (const [call, want] of gradeCases) {
  assert.strictEqual(gradeCall(call), want, `grade ${JSON.stringify(call)}`);
}

// HTTP 200 bodies that report failure are not finished (r/n8n commenter)
const bodyFailCases = [
  [{ http_status: 200, ok: false }, 'F'],
  [{ http_status: 200, success: false, id: 'm1' }, 'F'],
  [{ http_status: 200, succeeded: false }, 'F'],
  [{ http_status: 200, body: { ok: false } }, 'F'],
  [{ http_status: 200, body: { success: false } }, 'F'],
  [{ http_status: 200, body: { status: 'error' }, id: 'm1' }, 'F'],
  [{ http_status: 200, body: { status: 'failed' } }, 'F'],
  [{ http_status: 200, body: { status: 'FAILURE' } }, 'F'],
  [{ http_status: 200, data: { ok: 'false' } }, 'F'],
  [{ http_status: 200, body: { error: 'channel_not_found' } }, 'F'],
  [{ http_status: 200, body: { errors: [{ message: 'x' }] } }, 'F'],
  [{ http_status: 200, response: { body: { ok: false } }, id: 'm1' }, 'F'],
  [{ http_status: 200, body: { OK: false } }, 'F'],
  [{ http_status: 200, body: { errors: [] }, id: 'm1' }, 'S3'],
  [{ http_status: 200, body: { ok: true }, id: 'm1' }, 'S3'],
  [{ http_status: 200, body: { error: null }, id: 'm1' }, 'S3'],
  [{ http_status: 200, body: { error: '' }, id: 'm1' }, 'S3'],
];
for (const [call, want] of bodyFailCases) {
  assert.strictEqual(gradeCall(call), want, `body grade ${JSON.stringify(call)}`);
}
assert.strictEqual(gradeCall({ error: 'timeout' }), 'S1', 'top-level call.error stays S1');
assert.strictEqual(gradeCall({ http_status: 200, accepted: false, id: 'm1' }), 'S3');
assert.strictEqual(gradeCall({ http_status: 200, accepted: false, id: 'm1' }, ['accepted:false']), 'F');
assert.strictEqual(gradeCall({ http_status: 200, ok: false, id: 'm1' }, []), 'S3');
assert.ok(normalizeFailureMarkers(undefined).length > 0);
assert.deepStrictEqual(normalizeFailureMarkers([]), []);

{
  const f = one('I sent the proposal to dana@acme.com.',
    [{ action: 'send', target: 'dana@acme.com', http_status: 200, body: { ok: false }, id: 'm1' }]);
  assert.deepStrictEqual([f.status, f.grade], ['gap', 'F']);
}
{
  const r = diff('I refunded $45 for order 88412.',
    [{ action: 'pay', target: 'order 88412', amount: 45, http_status: 200, body: { success: false }, id: 're_1' }]);
  assert.strictEqual(r.findings[0].status, 'gap');
  assert.strictEqual(r.findings[0].grade, 'F');
  assert.strictEqual(r.stop_ship, true);
}
{
  const r = diff('I booked the room.',
    [{ action: 'book', http_status: 200, body: { status: 'error' } }]);
  assert.deepStrictEqual([r.findings[0].status, r.findings[0].grade], ['gap', 'F']);
  assert.strictEqual(r.stop_ship, false);
}
{
  const r = diff('I deleted the old account.',
    [{ action: 'delete', http_status: 200, body: { errors: ['not allowed'] }, id: 'x1' }]);
  assert.strictEqual(r.stop_ship, true);
  assert.strictEqual(r.findings[0].grade, 'F');
}

assert.deepStrictEqual(extractClaims("I will send the report tomorrow. I haven't booked the room yet. Should I pay the invoice?").map((c) => c.verb), []);

{
  const cs = extractClaims('I sent the proposal to dana@acme.com and booked the call.');
  assert.deepStrictEqual(cs.map((c) => [c.action, c.targets]), [['send', ['dana@acme.com']], ['book', []]]);
}
{
  const c = extractClaims('I refunded $1,045.50 for order 88412.')[0];
  assert.strictEqual(c.action, 'pay');
  assert.strictEqual(c.amount, 1045.5);
  assert.deepStrictEqual(c.targets, ['88412']);
  assert.strictEqual(extractClaims('We sent all three invoices.')[0].count, 3);
}
assert.strictEqual(extractClaims('The email was delivered.')[0].needs, 'S4');
assert.deepStrictEqual(extractClaims('Thanks for the file you sent.'), []);

{
  const f = one('I sent the proposal to dana@acme.com.',
    [{ tool: 'mail', action: 'send', target: 'dana@acme.com', status: 'done', id: 'm1' }]);
  assert.deepStrictEqual([f.status, f.grade], ['ok', 'S3']);
}
assert.deepStrictEqual([one('I booked the room.', []).status, one('I booked the room.', []).grade], ['gap', 'S0']);
{
  const f = one('I sent it.', [{ action: 'send', http_status: 202 }]);
  assert.deepStrictEqual([f.status, f.grade], ['gap', 'S2']);
}
{
  const f = one('I sent it.', [{ action: 'send', status: 'bounced' }]);
  assert.deepStrictEqual([f.status, f.grade], ['gap', 'F']);
}
{
  const f = one('I emailed dana@acme.com.',
    [{ action: 'send', target: 'dan@acme.com', status: 'done', id: 'm1' }]);
  assert.strictEqual(f.status, 'gap');
  assert.ok(f.reason.includes('wrong target'));
}
{
  const f = one('I refunded $45 for order 88412.',
    [{ action: 'pay', target: 'order 88412', amount: 40, status: 'done', id: 're_1' }]);
  assert.ok(f.reason.includes('amount mismatch'));
}
{
  const log = [1, 2, 3].map((i) => ({ action: 'send', target: `inv ${i}`, status: 'done', id: `m${i}` }));
  log.push({ action: 'send', target: 'inv 3', status: 'done', id: 'm4' });
  const f = one('I sent all 5 invoices.', log);
  assert.strictEqual(f.status, 'gap');
  assert.ok(f.reason.includes('3 of 5'), f.reason);
}
{
  const r = diff('All set!', [{ tool: 'cal', action: 'book', status: 'pending' }]);
  assert.strictEqual(r.findings[0].status, 'gap');
  assert.strictEqual(diff('All set!', []).findings[0].reason, 'umbrella claim, but the log has no tool calls');
  assert.strictEqual(diff('All set!', [{ action: 'book', status: 'done', id: 'e1' }]).findings[0].status, 'ok');
}
{
  const log = [
    { tool: 'mail', action: 'send', target: 'a@b.co', status: 'done', id: 'm1' },
    { tool: 'mail', action: 'send', target: 'a@b.co', status: 'done', id: 'm2' },
  ];
  assert.strictEqual(diff('', log).duplicates.length, 1);
  log.forEach((c) => { c.idempotency_key = 'k1'; });
  assert.deepStrictEqual(diff('', log).duplicates, []);
}
assert.strictEqual(diff('I paid the invoice.', []).stop_ship, true);
assert.strictEqual(diff('I booked the room.', []).stop_ship, false);

// n8n sample execution
const OSS = '/workspace/products/say-do-diff-oss';
const N8N = fs.existsSync(path.join(OSS, 'examples/n8n/sample_execution.json'))
  ? path.join(OSS, 'examples/n8n')
  : path.join(__dirname, 'fixtures');
const ex = JSON.parse(fs.readFileSync(path.join(N8N, 'sample_execution.json'), 'utf8'));
const nodeMap = JSON.parse(fs.readFileSync(path.join(N8N, 'node_map.json'), 'utf8'));
const calls = toLog(ex, nodeMap);
assert.strictEqual(calls.find((c) => c.action === 'pay').error, 'The connection timed out');
assert.strictEqual(calls.find((c) => c.action === 'send').id, '18c2f0a9');
assert.strictEqual(calls.find((c) => c.action === 'send').target, 'dana@acme.com');
assert.strictEqual(calls.find((c) => c.action === 'book').target, 'Dana demo Tuesday');
assert.strictEqual(calls.find((c) => c.action === 'book').status, 'done');
assert.ok(replyText(ex, nodeMap).startsWith('I sent the proposal'));
{
  const r = diff(replyText(ex, nodeMap), calls);
  assert.strictEqual(r.stop_ship, true);
  assert.strictEqual(r.gaps.length, 2);
}
{
  const out = checkPayload({ execution: ex, nodeMap }, null);
  assert.strictEqual(out.verdict, 'stop_ship');
  assert.strictEqual(out.gaps, 2);
  assert.strictEqual(out.claims, 4);
}

{
  const execution = {
    data: { resultData: { runData: {
      'Refund (HTTP Request)': [{
        data: { main: [[{ json: { ok: false, id: 're_1', error: 'card_declined', amount_usd: 45 } }]] },
      }],
    } } },
  };
  const nodeMap = {
    nodes: {
      'Refund (HTTP Request)': {
        tool: 'stripe.refund', action: 'pay', target_value: 'order 88412',
        id: 'id', amount: 'amount_usd',
      },
    },
  };
  const mapped = toLog(execution, nodeMap);
  assert.strictEqual(mapped.length, 1);
  assert.strictEqual(mapped[0].status, 'error');
  assert.strictEqual(mapped[0].id, 're_1');
  assert.strictEqual(mapped[0].note, 'response body reported failure');
  const out = checkPayload({
    reply: 'I refunded $45 for order 88412.',
    execution,
    nodeMap,
  }, null);
  assert.strictEqual(out.verdict, 'stop_ship');
  assert.strictEqual(out.gaps, 1);
  assert.strictEqual(out.calls[0].grade, 'F');
}

{
  const out = checkPayload({
    reply: 'I sent the proposal to dana@acme.com.',
    calls: [{ action: 'send', target: 'dana@acme.com', http_status: 200, ok: false, id: 'm1' }],
  }, null);
  assert.strictEqual(out.verdict, 'review');
  assert.strictEqual(out.calls[0].grade, 'F');
}

{
  const out = checkPayload({
    reply: 'I sent the proposal to dana@acme.com.',
    calls: [{ action: 'send', target: 'dana@acme.com', http_status: 200, ok: false, id: 'm1' }],
    failureMarkers: [],
  }, null);
  assert.strictEqual(out.verdict, 'pass');
  assert.strictEqual(out.calls[0].grade, 'S3');
}

// v1.2.0: passive and noun phrasings a commenter on r/n8n showed were missed
function verbActions(message) {
  return extractClaims(message).filter((c) => !c.umbrella).map((c) => [c.verb, c.action]);
}
assert.deepStrictEqual(verbActions('Your refund has been processed'), [['processed', 'pay']]);
assert.deepStrictEqual(verbActions('the order was cancelled'), [['cancelled', 'cancel']]);
assert.deepStrictEqual(verbActions('an email has been sent'), [['sent', 'send']]);
assert.deepStrictEqual(verbActions('The money is back on your card'), [['refunded', 'pay']]);
assert.deepStrictEqual(verbActions('Done, invite is out'), [['invited', 'send']]);
assert.deepStrictEqual(verbActions('I went ahead and got the refund issued'), [['issued', 'pay']]);
assert.deepStrictEqual(extractClaims('Your refund has not been processed'), []);
assert.deepStrictEqual(extractClaims('Your refund will be processed tomorrow.'), []);
assert.deepStrictEqual(extractClaims("The refund hasn't been processed."), []);
assert.deepStrictEqual(extractClaims('Thanks for the file you sent.'), []);
{
  const r = diff('Your refund has been processed', []);
  assert.strictEqual(r.findings[0].status, 'gap');
  assert.strictEqual(r.findings[0].claim.action, 'pay');
  assert.strictEqual(r.stop_ship, true);
}
{
  const r = diff('Your refund has been processed for order 88412.',
    [{ action: 'pay', target: 'order 88412', status: 'done', id: 're_1' }]);
  assert.strictEqual(r.findings[0].status, 'ok');
  assert.strictEqual(r.stop_ship, false);
}
{
  const r = diff('The order was cancelled.', []);
  assert.strictEqual(r.findings[0].claim.action, 'cancel');
  assert.strictEqual(r.findings[0].status, 'gap');
  assert.strictEqual(r.stop_ship, false);
}
{
  const r = diff('An email has been sent to dana@acme.com.',
    [{ action: 'send', target: 'dana@acme.com', status: 'done', id: 'm1' }]);
  assert.deepStrictEqual([r.findings[0].status, r.findings[0].grade], ['ok', 'S3']);
}
{
  const c = extractClaims('Your $45 refund has been processed for order 88412.')[0];
  assert.strictEqual(c.action, 'pay');
  assert.strictEqual(c.amount, 45);
  assert.ok(c.targets.includes('88412'));
}

// v1.2.0: optional structured actions mode
{
  const out = checkPayload({
    reply: 'All set!',
    actions: [{ action: 'refund', status: 'done', target: 'order 88412', amount: 45 }],
    calls: [{ action: 'pay', target: 'order 88412', amount: 45, error: 'timeout' }],
  }, null);
  assert.strictEqual(out.verdict, 'stop_ship');
  assert.ok(out.gaps >= 1);
  const pay = out.findings.filter((f) => f.claim.action === 'pay');
  assert.ok(pay.length >= 1);
  assert.strictEqual(pay[0].status, 'gap');
}
{
  const out = checkPayload({
    reply: 'All set!',
    actions: [{ action: 'refund', status: 'done', target: 'order 88412', amount: 45 }],
    calls: [{ action: 'pay', target: 'order 88412', amount: 45, status: 'done', id: 're_1' }],
  }, null);
  assert.strictEqual(out.verdict, 'pass');
}
{
  const out = checkPayload({
    reply: JSON.stringify({ text: 'All set!', actions: [{ action: 'refund', status: 'done', amount: 45 }] }),
    calls: [],
  }, null);
  assert.strictEqual(out.verdict, 'stop_ship');
  assert.strictEqual(out.reply, 'All set!');
}
{
  const out = checkPayload({
    actions: [{ action: 'refund', status: 'done' }],
    calls: [{ action: 'pay', status: 'done', id: 're_1' }],
  }, null);
  assert.strictEqual(out.verdict, 'pass');
  assert.strictEqual(out.findings.length, 1);
}
{
  const out = checkPayload({
    reply: 'I also booked the room.',
    actions: [{ action: 'refund', status: 'done' }],
    calls: [{ action: 'pay', status: 'done', id: 're_1' }],
  }, null);
  assert.strictEqual(out.verdict, 'review');
  assert.strictEqual(out.findings.find((f) => f.claim.action === 'book').status, 'gap');
  assert.strictEqual(out.findings.find((f) => f.claim.action === 'pay').status, 'ok');
}
{
  const out = checkPayload({
    reply: 'I refunded $45 for order 88412.',
    actions: [{ action: 'refund', status: 'done', target: 'order 88412', amount: 45 }],
    calls: [{ action: 'pay', target: 'order 88412', amount: 45, status: 'done', id: 're_1' }],
  }, null);
  const pays = out.findings.filter((f) => f.claim.action === 'pay');
  assert.strictEqual(pays.length, 1);
  assert.strictEqual(out.verdict, 'pass');
}
{
  const out = checkPayload({
    actions: [{ action: 'email', status: 'delivered', target: 'dana@acme.com' }],
    calls: [{ action: 'send', target: 'dana@acme.com', status: 'done', id: 'm1' }],
  }, null);
  assert.strictEqual(out.findings[0].claim.action, 'send');
  assert.strictEqual(out.findings[0].claim.needs, 'S4');
  assert.strictEqual(out.findings[0].status, 'gap');
  assert.strictEqual(out.verdict, 'review');
}
{
  let threw = false;
  try {
    checkPayload({ calls: [] }, null);
  } catch (e) {
    threw = /Missing "reply"/.test(e.message);
  }
  assert.ok(threw, 'empty payload should still require a reply or actions');
}

// ---------------------------------------------------------------------------
// v1.3.0
const L13 = require('./saydo_check');
function chk(payload) { return L13.checkPayload(payload, null); }
function stat(out) { return out.findings.map((f) => `${f.status}/${f.grade}`); }
let n13 = 0;
function t13(name, fn) { fn(); n13 += 1; }

// 1. Partial outcomes (a commenter on r/n8n)
t13('grade P for created/failed', () => {
  assert.strictEqual(gradeCall({ http_status: 200, id: 'b1', body: { created: 48, failed: 2 } }), 'P');
});
for (const body of [
  { succeeded: 48, errors: 2 },
  { success_count: 48, failure_count: 2 },
  { successCount: 48, failureCount: 2 },
  { sent: 48, failed: ['a@x.co', 'b@x.co'] },
  { data: { created: 48, failed: 2 } },
  { results: [{ status: 'ok' }, { status: 'error', error: 'bad address' }] },
  { items: [{ ok: true }, { ok: false }] },
  { responses: [{ id: '1', status: 201 }, { id: '2', status: 400 }] },
  { replies: [{ success: true }, { success: false }] },
]) {
  t13(`partial body ${JSON.stringify(body)}`, () => {
    assert.strictEqual(gradeCall({ http_status: 200, id: 'b1', body }), 'P', JSON.stringify(body));
  });
}
t13('top level array body', () => {
  assert.strictEqual(gradeCall({ http_status: 200, id: 'b1', body: [{ status: 'sent' }, { status: 'bounced' }] }), 'P');
});
t13('all items failed is F', () => {
  assert.strictEqual(gradeCall({ http_status: 200, id: 'b1', body: { created: 0, failed: 3 } }), 'F');
  assert.strictEqual(gradeCall({ http_status: 200, id: 'b1', body: { results: [{ ok: false }, { ok: false }] } }), 'F');
});
t13('clean batch stays S3', () => {
  assert.strictEqual(gradeCall({ http_status: 200, id: 'b1', body: { created: 50, failed: 0 } }), 'S3');
  assert.strictEqual(gradeCall({ http_status: 200, id: 'b1', body: { results: [{ status: 'ok' }, { status: 'ok' }] } }), 'S3');
});
t13('list of records with no outcome fields is not a batch', () => {
  assert.strictEqual(gradeCall({ http_status: 200, id: 'c1', body: { data: [{ id: 1, status: 'active' }] } }), 'S3');
});
t13('pending items make a batch partial', () => {
  assert.strictEqual(gradeCall({ http_status: 200, id: 'b1', body: { items: [{ status: 'sent' }, { status: 'queued' }] } }), 'P');
});
t13('"all 50 sent" with 48/2 is review with counts', () => {
  const out = chk({ reply: 'All 50 invites sent.', calls: [{ tool: 'mailer', action: 'send', http_status: 200, id: 'b1', body: { created: 48, failed: 2 } }] });
  assert.strictEqual(out.verdict, 'review');
  assert.deepStrictEqual(stat(out), ['partial/P']);
  assert.strictEqual(out.partials, 1);
  assert.strictEqual(out.gaps, 1);
  assert.ok(out.findings[0].reason.includes('claim says 50'), out.findings[0].reason);
  assert.ok(out.findings[0].reason.includes('48 of 50 succeeded, 2 failed'), out.findings[0].reason);
  assert.ok(out.report.includes('[PART]'));
  assert.deepStrictEqual(out.calls[0].batch, { succeeded: 48, failed: 2, pending: 0, total: 50, field: 'created/failed' });
});
t13('"sent the invites" with partial evidence is review', () => {
  const out = chk({ reply: 'I sent the invites.', calls: [{ action: 'send', http_status: 200, id: 'b1', body: { succeeded: 48, errors: 2 } }] });
  assert.strictEqual(out.verdict, 'review');
  assert.ok(out.findings[0].reason.startsWith('partial: 48 of 50 succeeded, 2 failed'));
});
t13('"all 50 sent" with a clean 50/0 batch passes', () => {
  const out = chk({ reply: 'All 50 invites sent.', calls: [{ action: 'send', http_status: 200, id: 'b1', body: { created: 50, failed: 0 } }] });
  assert.strictEqual(out.verdict, 'pass');
  assert.strictEqual(out.findings[0].reason, '50 of 50 reached S3');
});
t13('partial refunds are stop_ship', () => {
  const out = chk({ reply: 'All 3 refunds issued.', calls: [{ action: 'pay', http_status: 200, id: 'b1', body: { success_count: 2, failure_count: 1 } }] });
  assert.strictEqual(out.verdict, 'stop_ship');
  assert.strictEqual(out.findings[0].status, 'partial');
});
t13('umbrella over a partial batch is partial', () => {
  const out = chk({ reply: 'All set!', calls: [{ tool: 'mailer', action: 'send', http_status: 200, id: 'b1', body: { created: 48, failed: 2 } }] });
  assert.deepStrictEqual(stat(out), ['partial/P']);
  assert.strictEqual(out.verdict, 'review');
});
t13('partialRules from the payload replace the default list', () => {
  const calls = [{ action: 'send', http_status: 200, id: 'b1', body: { good: 4, bad: 1 } }];
  assert.strictEqual(chk({ reply: 'I sent the invites.', calls }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'I sent the invites.', calls, partialRules: { countPairs: [['good', 'bad']] } }).verdict, 'review');
  assert.strictEqual(chk({ reply: 'I sent the invites.', calls, partialRules: JSON.stringify([['good', 'bad']]) }).verdict, 'review');
  assert.strictEqual(L13.checkPayload({ reply: 'I sent the invites.', calls }, null, undefined, { countPairs: [['good', 'bad']] }).verdict, 'review');
});
t13('invalid partialRules JSON fails clearly', () => {
  assert.throws(() => chk({ reply: 'I sent it.', calls: [], partialRules: '{bad' }), /partialRules/);
});

// 2. Negated and future tense are not claims; "couldn't" and "pending" are disclosures
for (const reply of [
  'I will refund $45 for order 88412.',
  "I'll send the invoice today.",
  "I couldn't send the invoice.",
  'I was unable to book the room.',
  'Your refund is pending.',
  'Refund pending for order 88412.',
  'I haven’t sent it yet.',
  'I won’t charge the card.',
  'I failed to send the email.',
  "The email didn't get sent.",
  'I cannot cancel that order.',
  'Once approved, the invoice will be sent.',
]) {
  t13(`no claim: ${reply}`, () => {
    const out = chk({ reply, calls: [] });
    assert.strictEqual(out.claims, 0, `${reply} -> ${out.report}`);
    assert.strictEqual(out.verdict, 'pass');
  });
}
t13('disclosures are listed and do not change the verdict', () => {
  const out = chk({ reply: "I couldn't send the invoice. I was unable to book the room. Your refund is pending. I'll send the report tomorrow.", calls: [] });
  assert.deepStrictEqual(out.disclosures.map((d) => [d.kind, d.action]), [['not_done', 'send'], ['not_done', 'book'], ['pending', 'pay']]);
  assert.strictEqual(out.verdict, 'pass');
  assert.ok(out.report.includes('[NOTE] reply says send is not done'));
});
t13('a disclosure next to a real claim still grades the claim', () => {
  const out = chk({ reply: "I booked the demo, but I couldn't send the invoice.", calls: [] });
  assert.deepStrictEqual(out.findings.map((f) => f.claim.action), ['book']);
  assert.strictEqual(out.disclosures.length, 1);
  assert.strictEqual(out.verdict, 'review');
});

// 3. Robustness
t13('empty log array, empty string, and missing log', () => {
  assert.strictEqual(chk({ reply: 'I sent it.', calls: [] }).findings[0].reason, "no 'send' call in the log");
  assert.strictEqual(chk({ reply: 'I sent it.', calls: '' }).verdict, 'review');
  assert.throws(() => chk({ reply: 'I sent it.' }), /Missing "calls"/);
});
t13('malformed JSON log and execution fail with a clear message', () => {
  assert.throws(() => chk({ reply: 'I sent it.', calls: '{oops' }), /Could not read "calls": line 1/);
  assert.throws(() => chk({ reply: 'I sent it.', execution: '{bad', nodeMap: { nodes: {} } }), /Could not read "execution"/);
});
t13('JSON lines log and string execution are accepted', () => {
  const jsonl = '{"action":"send","status":"done","id":"m1"}\n{"action":"book","status":"done","id":"e1"}';
  assert.strictEqual(chk({ reply: 'I sent it and booked the room.', calls: jsonl }).verdict, 'pass');
  const out = chk({ execution: JSON.stringify(ex), nodeMap });
  assert.strictEqual(out.verdict, 'stop_ship');
});
t13('payload null, array, string', () => {
  assert.throws(() => chk(null), /must be a JSON object/);
  assert.throws(() => chk([]), /must be a JSON object/);
  assert.throws(() => chk('not json'), /not valid JSON/);
  assert.strictEqual(chk('{"reply":"I sent it.","calls":[]}').verdict, 'review');
});
t13('junk entries in the log are skipped', () => {
  const out = chk({ reply: 'I sent it.', calls: [null, 5, 'x', [], { action: 'send', status: 'done', id: 'm' }] });
  assert.strictEqual(out.verdict, 'pass');
  assert.strictEqual(out.calls.length, 1);
});
t13('a single call object is read as a one entry log', () => {
  assert.strictEqual(chk({ reply: 'I sent it.', calls: { action: 'send', status: 'done', id: 'm' } }).verdict, 'pass');
});
t13('non English sentence punctuation splits sentences', () => {
  const cs = extractClaims('I sent the proposal to dana@acme.com。I booked the room！');
  assert.deepStrictEqual(cs.map((c) => c.sentence), ['I sent the proposal to dana@acme.com。', 'I booked the room！']);
});
t13('curly quotes and apostrophes are normalized', () => {
  assert.deepStrictEqual(extractClaims('I haven’t sent it.'), []);
  assert.deepStrictEqual(extractClaims('I created “Q3 plan”.')[0].targets, ['q3 plan']);
});
t13('several claims in one sentence are graded separately', () => {
  const out = chk({
    reply: 'I sent the proposal to dana@acme.com, refunded $45 for order 88412 and booked the demo.',
    calls: [
      { action: 'send', target: 'dana@acme.com', status: 'done', id: 'm1' },
      { action: 'book', status: 'done', id: 'e1' },
      { action: 'pay', target: 'order 88412', amount: 45, error: 'timeout' },
    ],
  });
  assert.deepStrictEqual(stat(out), ['ok/S3', 'gap/S1', 'ok/S3']);
  assert.strictEqual(out.verdict, 'stop_ship');
});
t13('amount mismatch: claim $45, log "40.00"', () => {
  const out = chk({ reply: 'I refunded $45 for order 88412.', calls: [{ action: 'pay', target: 'order 88412', amount: '40.00', status: 'done', id: 're' }] });
  assert.strictEqual(out.findings[0].reason, 'amount mismatch: claim says 45, log shows 40');
  assert.strictEqual(out.verdict, 'stop_ship');
});
t13('amount strings with symbols and decimals match', () => {
  for (const amount of ['45.00', '$45.00', '45', 45, '45.0 USD']) {
    assert.strictEqual(chk({ reply: 'I refunded $45 for order 88412.', calls: [{ action: 'pay', target: 'order 88412', amount, status: 'done', id: 're' }] }).verdict, 'pass', String(amount));
  }
});
t13('amounts in cents', () => {
  const base = { action: 'pay', status: 'done', id: 're' };
  assert.strictEqual(chk({ reply: 'I refunded $45.', calls: [{ ...base, amount_cents: 4500 }] }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'I refunded $45.', calls: [{ ...base, amount: 4500, amount_unit: 'cents' }] }).verdict, 'pass');
  const out = chk({ reply: 'I refunded $45.', calls: [{ ...base, amount: 4500 }] });
  assert.strictEqual(out.verdict, 'stop_ship');
  assert.ok(out.findings[0].reason.includes('amount_cents'));
});
t13('currency mismatch and currency codes in text', () => {
  const out = chk({ reply: 'I refunded €45.', calls: [{ action: 'pay', amount: 45, currency: 'usd', status: 'done', id: 're' }] });
  assert.strictEqual(out.findings[0].reason, 'currency mismatch: claim says EUR, log shows USD');
  assert.strictEqual(extractClaims('I refunded 45 USD.')[0].amount, 45);
  assert.strictEqual(extractClaims('I refunded USD 1,045.50.')[0].amount, 1045.5);
  assert.deepStrictEqual(extractClaims('I refunded 450 EUR.')[0].targets, []);
  assert.strictEqual(chk({ reply: 'I refunded 45 USD.', calls: [{ action: 'pay', amount: 40, status: 'done', id: 're' }] }).verdict, 'stop_ship');
});
t13('wrong recipient email, including a prefix of the real one', () => {
  const a = chk({ reply: 'I emailed dana@acme.com.', calls: [{ action: 'send', target: 'dana@acme.co', status: 'done', id: 'm' }] });
  assert.strictEqual(a.findings[0].reason, "wrong target: claim names dana@acme.com, log has 'send' for: dana@acme.co");
  const b = chk({ reply: 'I emailed dana@acme.co.', calls: [{ action: 'send', target: 'dana@acme.com', status: 'done', id: 'm' }] });
  assert.strictEqual(b.verdict, 'review');
  const c = chk({ reply: 'I emailed Dana@Acme.com.', calls: [{ action: 'send', target: { to: ['dana@acme.com'] }, status: 'done', id: 'm' }] });
  assert.strictEqual(c.verdict, 'pass');
});
t13('order 185 does not match order 1850', () => {
  const out = chk({ reply: 'I refunded order 185.', calls: [{ action: 'pay', target: 'order 1850', status: 'done', id: 'r' }] });
  assert.ok(out.findings[0].reason.startsWith('wrong target'));
});
t13('duplicated tool calls are reported', () => {
  const out = chk({ reply: 'I sent it.', calls: [
    { tool: 'g', action: 'send', target: 'a@b.co', status: 'done', id: 'm1' },
    { tool: 'g', action: 'send', target: 'a@b.co', status: 'done', id: 'm2' },
  ] });
  assert.strictEqual(out.duplicates.length, 1);
  assert.ok(out.report.includes('[DUP]'));
});
t13('retry: first attempt failed, second succeeded', () => {
  const out = chk({ reply: 'I sent it to a@b.co.', calls: [
    { tool: 's', action: 'send', target: 'a@b.co', http_status: 500 },
    { tool: 's', action: 'send', target: 'a@b.co', status: 'done', id: 'm' },
  ] });
  assert.strictEqual(out.verdict, 'pass');
  assert.deepStrictEqual(out.duplicates, []);
  const all = chk({ reply: 'All set!', calls: [
    { tool: 's', action: 'send', target: 'a@b.co', http_status: 500 },
    { tool: 's', action: 'send', target: 'a@b.co', status: 'done', id: 'm' },
  ] });
  assert.strictEqual(all.verdict, 'pass');
});
t13('retry after a timeout without an idempotency key is flagged as a possible double action', () => {
  const calls = [
    { tool: 's', action: 'pay', target: 'order 88412', amount: 45, error: 'timeout' },
    { tool: 's', action: 'pay', target: 'order 88412', amount: 45, status: 'done', id: 're' },
  ];
  const out = chk({ reply: 'I refunded $45 for order 88412.', calls });
  assert.strictEqual(out.verdict, 'pass');
  assert.strictEqual(out.duplicates[0].kind, 'retry_after_unknown');
  assert.ok(out.report.includes('may have run twice'));
  calls.forEach((c) => { c.idempotency_key = 'k1'; });
  assert.deepStrictEqual(chk({ reply: 'I refunded $45 for order 88412.', calls }).duplicates, []);
});
t13('a later bounce for the same id or target overrides the earlier success', () => {
  const a = chk({ reply: 'I sent it to a@b.co.', calls: [
    { tool: 's', action: 'send', target: 'a@b.co', status: 'done', id: 'm1' },
    { tool: 's', action: 'send', id: 'm1', status: 'bounced' },
  ] });
  assert.strictEqual(a.verdict, 'review');
  assert.ok(a.findings[0].reason.includes('later reported bounced for id m1'), a.findings[0].reason);
  const b = chk({ reply: 'I sent it to a@b.co.', calls: [
    { tool: 's', action: 'send', target: 'a@b.co', status: 'done', id: 'm1' },
    { tool: 's', action: 'send', target: 'a@b.co', status: 'bounced' },
  ] });
  assert.strictEqual(b.findings[0].grade, 'F');
});
t13('timeouts', () => {
  assert.deepStrictEqual(stat(chk({ reply: 'I booked it.', calls: [{ action: 'book', status: 'timed_out' }] })), ['gap/S1']);
  assert.deepStrictEqual(stat(chk({ reply: 'I booked it.', calls: [{ action: 'book', error: 'ETIMEDOUT' }] })), ['gap/S1']);
});
t13('200 with ok:false and 202 accepted/queued', () => {
  assert.deepStrictEqual(stat(chk({ reply: 'I sent it.', calls: [{ action: 'send', http_status: 200, body: { ok: false }, id: 'm' }] })), ['gap/F']);
  assert.deepStrictEqual(stat(chk({ reply: 'I sent it.', calls: [{ action: 'send', http_status: 202, id: 'm' }] })), ['gap/S2']);
  assert.deepStrictEqual(stat(chk({ reply: 'I sent it.', calls: [{ action: 'send', status: 'queued', id: 'm' }] })), ['gap/S2']);
  assert.deepStrictEqual(stat(chk({ reply: 'The email was delivered.', calls: [{ action: 'send', http_status: 202, id: 'm' }] })), ['gap/S2']);
});
t13('HTTP status as a string or under other field names', () => {
  assert.deepStrictEqual(stat(chk({ reply: 'I sent it.', calls: [{ action: 'send', http_status: '200', id: 'm' }] })), ['ok/S3']);
  assert.deepStrictEqual(stat(chk({ reply: 'I sent it.', calls: [{ action: 'send', http_status: '500', id: 'm' }] })), ['gap/F']);
  assert.deepStrictEqual(stat(chk({ reply: 'I sent it.', calls: [{ action: 'send', statusCode: 500, id: 'm' }] })), ['gap/F']);
  assert.deepStrictEqual(stat(chk({ reply: 'I sent it.', calls: [{ action: 'send', status: 404, id: 'm' }] })), ['gap/F']);
});
t13('log action names are case insensitive and accept aliases', () => {
  assert.strictEqual(chk({ reply: 'I sent it.', calls: [{ action: 'Send', status: 'done', id: 'm' }] }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'I sent it.', calls: [{ action: 'email', status: 'done', id: 'm' }] }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'I refunded it.', calls: [{ action: 'refund', status: 'done', id: 'r' }] }).verdict, 'pass');
});
t13('a bare "Done." is an umbrella claim', () => {
  assert.deepStrictEqual(stat(chk({ reply: 'Done.', calls: [{ action: 'send', error: 'timeout' }] })), ['gap/S1']);
  assert.strictEqual(chk({ reply: "It's done!", calls: [{ action: 'send', status: 'done', id: 'm' }] }).verdict, 'pass');
  assert.deepStrictEqual(extractClaims('Done, invite is out').filter((c) => c.umbrella), []);
});
t13('headline style refund claim', () => {
  assert.strictEqual(chk({ reply: 'Refund issued for order 88412.', calls: [] }).verdict, 'stop_ship');
});
t13('ids are not counts', () => {
  const c = extractClaims('Your refund for order #185 has been processed.')[0];
  assert.strictEqual(c.count, null);
  assert.deepStrictEqual(c.targets, ['185']);
  assert.deepStrictEqual(extractClaims('I sent all 150 invoices.')[0].targets, []);
  assert.strictEqual(extractClaims('I sent all 150 invoices.')[0].count, 150);
});
t13('a numeric reply is read as text', () => {
  assert.strictEqual(chk({ reply: 42, calls: [] }).verdict, 'pass');
});

// 4. Claims bind to the matching call (a commenter on r/n8n)
const twoRefunds = [
  { tool: 'stripe.refund', action: 'pay', target: 'order #184', amount: 30, status: 'done', id: 're_184' },
  { tool: 'stripe.refund', action: 'pay', target: 'order #185', amount: 45, http_status: 402, body: { error: { code: 'card_declined' } } },
];
t13('#185 failed, #185 customer told "processed": stop_ship', () => {
  const out = chk({ reply: 'Your refund for order #185 has been processed.', calls: twoRefunds });
  assert.strictEqual(out.verdict, 'stop_ship');
  assert.deepStrictEqual(stat(out), ['gap/F']);
  assert.deepStrictEqual(out.findings[0].calls, [1]);
});
t13('#184 succeeded, #184 customer told "processed": pass', () => {
  assert.strictEqual(chk({ reply: 'Your refund for order #184 has been processed.', calls: twoRefunds }).verdict, 'pass');
});
t13('no id in the reply: ambiguous, not borrowed from #184', () => {
  const out = chk({ reply: 'Your refund has been processed.', calls: twoRefunds });
  assert.strictEqual(out.verdict, 'stop_ship');
  assert.ok(out.findings[0].reason.startsWith('ambiguous target'), out.findings[0].reason);
  assert.ok(out.findings[0].reason.includes('order #185 F'));
});
t13('replyTarget binds a reply with no id', () => {
  assert.strictEqual(chk({ reply: 'Your refund has been processed.', calls: twoRefunds, replyTarget: '#185' }).verdict, 'stop_ship');
  assert.strictEqual(chk({ reply: 'Your refund has been processed.', calls: twoRefunds, replyTarget: 'order 184' }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'Your refund has been processed.', calls: twoRefunds, recipient: 'order 185' }).verdict, 'stop_ship');
});
t13('amount binds a reply with no id', () => {
  assert.strictEqual(chk({ reply: 'Your $45 refund has been processed.', calls: twoRefunds }).verdict, 'stop_ship');
  assert.strictEqual(chk({ reply: 'Your $30 refund has been processed.', calls: twoRefunds }).verdict, 'pass');
});
t13('recipient binds a send claim', () => {
  const calls = [
    { action: 'send', target: 'a@x.co', status: 'done', id: 'm1' },
    { action: 'send', target: 'b@x.co', status: 'bounced' },
  ];
  assert.strictEqual(chk({ reply: 'I emailed b@x.co.', calls }).verdict, 'review');
  assert.strictEqual(chk({ reply: 'I emailed a@x.co.', calls }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'I sent the email.', calls }).verdict, 'review');
});
t13('two targets that both finished still pass with no id', () => {
  const ok = twoRefunds.map((c) => ({ tool: c.tool, action: c.action, target: c.target, amount: c.amount, status: 'done', id: `re_${c.amount}` }));
  assert.strictEqual(chk({ reply: 'Your refund has been processed.', calls: ok }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'Both refunds have been processed.', calls: ok }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'Both refunds have been processed.', calls: twoRefunds }).verdict, 'stop_ship');
});

t13('a failed call explains itself in the reason', () => {
  const out = chk({ reply: 'Your refund for order #185 has been processed.', calls: twoRefunds });
  assert.strictEqual(out.findings[0].reason, 'wording needs S3, best evidence is F (HTTP 402, card_declined)');
});
t13('README sample files give the documented verdicts through check.js', () => {
  const want = {
    '1-refund-timeout.json': ['stop_ship', 2],
    '2-batch-partial.json': ['review', 1],
    '3-two-refunds-185-failed.json': ['stop_ship', 2],
    '4-supported-send-and-book.json': ['pass', 0],
    '5-honest-failure.json': ['pass', 0],
    '6-future-tense-credit.json': ['stop_ship', 2],
  };
  for (const [file, [verdict, code]] of Object.entries(want)) {
    const res = spawnSync(process.execPath, [path.join(__dirname, 'check.js'), path.join(__dirname, 'samples', file)], { encoding: 'utf8' });
    assert.strictEqual(res.status, code, `${file}: ${res.stdout}${res.stderr}`);
    assert.ok(res.stdout.startsWith(`verdict: ${verdict}`), file);
  }
  const bad = spawnSync(process.execPath, [path.join(__dirname, 'check.js'), '-'], { input: '{"reply":"I sent it."}', encoding: 'utf8' });
  assert.strictEqual(bad.status, 3);
  assert.match(bad.stderr, /Missing "calls"/);
});

t13('targets and amounts are read from tool arguments when no target is logged', () => {
  const log = [
    { tool: 'stripe.refund', action: 'pay', args: { order: '184', amount: 30 }, status: 'succeeded', id: 're_184' },
    { tool: 'stripe.refund', action: 'pay', args: { order: '185', amount: 45 }, status: 'failed', error: 'card_declined' },
  ];
  assert.strictEqual(chk({ reply: 'Your refund for order #185 has been processed.', calls: log }).verdict, 'stop_ship');
  assert.strictEqual(chk({ reply: 'Your refund for order #184 has been processed.', calls: log }).verdict, 'pass');
  assert.strictEqual(chk({ reply: 'Your refund has been processed.', calls: log }).verdict, 'stop_ship');
  assert.strictEqual(chk({ reply: 'Your $45 refund has been processed.', calls: log }).verdict, 'stop_ship');
  assert.strictEqual(chk({ reply: 'I refunded $30.', calls: log }).verdict, 'pass');
  const both = log.map((c) => ({ ...c, status: 'succeeded', error: undefined, id: `re_${c.args.order}` }));
  assert.deepStrictEqual(chk({ reply: 'Both refunds have been processed.', calls: both }).duplicates, []);
  assert.strictEqual(chk({ reply: 'Both refunds have been processed.', calls: both }).verdict, 'pass');
});

assert.strictEqual(L13.VERSION, '1.4.0');
console.log(`v1.3.0 cases passed: ${n13}`);

// --- v1.4.0: implied completion (u/Innenausbau_Aweys on r/n8n: a future
// tense promise after a failed or missing refund graded clean in 1.3.0)
let n14 = 0;
function t14(name, fn) { fn(); n14 += 1; }
const declined = [{ tool: 'stripe.refund', action: 'refund', args: { order: '185' }, status: 'failed', error: 'card_declined' }];
const refunded = [{ tool: 'stripe.refund', action: 'refund', args: { order: '185' }, status: 'succeeded', id: 're_185' }];
const reported = [
  "You'll see the credit on your statement in 3-5 days.",
  'You will receive your refund within 5 business days.',
  'The credit will appear on your card in 3 to 5 days.',
];
t14('the three reported phrasings are claims: stop_ship on a failed refund', () => {
  for (const reply of reported) {
    const out = chk({ reply, calls: declined });
    assert.strictEqual(out.claims, 1, reply);
    assert.strictEqual(out.verdict, 'stop_ship', reply);
    assert.deepStrictEqual(stat(out), ['gap/F'], reply);
    assert.ok(out.findings[0].reason.startsWith('implied refund: '), out.findings[0].reason);
  }
});
t14('the three reported phrasings are claims: stop_ship with no refund call', () => {
  for (const reply of reported) {
    const out = chk({ reply, calls: [] });
    assert.strictEqual(out.verdict, 'stop_ship', reply);
    assert.deepStrictEqual(stat(out), ['gap/S0'], reply);
  }
});
t14('the three reported phrasings pass when the refund finished with an id', () => {
  for (const reply of reported) {
    const out = chk({ reply, calls: refunded });
    assert.strictEqual(out.verdict, 'pass', reply);
    assert.deepStrictEqual(stat(out), ['ok/S3'], reply);
  }
});
t14('more refund and card wording', () => {
  for (const reply of [
    'It will appear on your card within 5-7 business days.',
    'The refund should show up on your statement by Friday.',
    'Your money is on its way back to you.',
    'The $45 will be refunded to your original payment method.',
    'You will be credited within 3 days.',
    'Please allow 5-10 business days for the refund to post.',
    'The charge will appear on your statement as ACME.',
    'You\u2019ll see the credit on your statement in 3\u20135 days.',
  ]) {
    const out = chk({ reply, calls: declined });
    assert.strictEqual(out.claims, 1, reply);
    assert.strictEqual(out.verdict, 'stop_ship', reply);
  }
});
t14('time spans are not order ids or counts', () => {
  const out = chk({ reply: 'It will appear on your card within 120 days.', calls: refunded });
  assert.strictEqual(out.verdict, 'pass');
  assert.deepStrictEqual(out.findings[0].claim.targets, []);
  assert.strictEqual(extractClaims('Your refund has been processed, allow 5 business days.')[0].count, null);
  assert.strictEqual(extractClaims('I sent all 50 invites.')[0].count, 50);
});
t14('an implied refund binds to the order it names', () => {
  const two = [
    { tool: 'stripe.refund', action: 'pay', target: 'order #184', status: 'done', id: 're_184' },
    { tool: 'stripe.refund', action: 'pay', target: 'order #185', status: 'failed', error: 'card_declined' },
  ];
  assert.strictEqual(chk({ reply: "For order #185 you'll see the credit in 3-5 days.", calls: two }).verdict, 'stop_ship');
  assert.strictEqual(chk({ reply: "For order #184 you'll see the credit in 3-5 days.", calls: two }).verdict, 'pass');
  const amb = chk({ reply: "You'll see the credit in 3-5 days.", calls: two });
  assert.strictEqual(amb.verdict, 'stop_ship');
  assert.ok(amb.findings[0].reason.includes('ambiguous target'), amb.findings[0].reason);
});
t14('an explicit claim plus its consequence is one claim', () => {
  const a = chk({ reply: "Your refund has been processed and you'll see the credit in 3-5 days.", calls: declined });
  assert.strictEqual(a.claims, 1);
  assert.strictEqual(a.verdict, 'stop_ship');
  const b = chk({ reply: "I refunded order 185. You'll see the credit in 3-5 days.", calls: refunded });
  assert.strictEqual(b.claims, 1);
  assert.strictEqual(b.verdict, 'pass');
});
t14('confirmation email on its way', () => {
  const mailOk = [{ tool: 'gmail.send', action: 'send', target: 'a@x.co', status: 'sent', id: 'm1' }];
  const bounced = [{ tool: 'gmail.send', action: 'send', target: 'a@x.co', status: 'bounced' }];
  const slackOnly = [{ tool: 'slack.post', action: 'send', target: '#ops', status: 'ok', id: 's1' }];
  for (const reply of [
    'A confirmation email is on its way.',
    'You should receive a confirmation email shortly.',
    'Your receipt is on its way.',
    'Check your inbox for the details.',
    'The invite should be in your inbox now.',
  ]) {
    assert.strictEqual(chk({ reply, calls: mailOk }).verdict, 'pass', reply);
    assert.strictEqual(chk({ reply, calls: [] }).verdict, 'review', reply);
    assert.deepStrictEqual(stat(chk({ reply, calls: bounced })), ['gap/F'], reply);
  }
  const s = chk({ reply: 'A confirmation email is on its way.', calls: slackOnly });
  assert.strictEqual(s.verdict, 'review');
  assert.ok(s.findings[0].reason.includes('only chat sends (slack.post)'), s.findings[0].reason);
  const custom = [{ tool: 'send_confirmation', action: 'send', status: 'done', id: 'c1' }];
  assert.strictEqual(chk({ reply: 'A confirmation email is on its way.', calls: custom }).verdict, 'pass');
});
t14('tracking number coming means a shipment exists', () => {
  const shipOk = [{ tool: 'shippo.create_shipment', action: 'create', args: { order: '185' }, status: 'created', id: 'shp_1' }];
  const shipFail = [{ tool: 'shippo.create_shipment', action: 'create', status: 'error', error: 'address_invalid' }];
  const ticketOnly = [{ tool: 'zendesk.ticket', action: 'create', status: 'done', id: 't1' }];
  for (const reply of [
    'Your tracking number is coming.',
    'Your tracking number will be emailed shortly.',
    "You'll get a tracking link today.",
    'Your replacement is on its way.',
    'Your package will arrive in 2 days.',
  ]) {
    assert.strictEqual(chk({ reply, calls: shipOk }).verdict, 'pass', reply);
    assert.strictEqual(chk({ reply, calls: [] }).verdict, 'review', reply);
    assert.deepStrictEqual(stat(chk({ reply, calls: shipFail })), ['gap/F'], reply);
    assert.deepStrictEqual(stat(chk({ reply, calls: ticketOnly })), ['gap/S0'], reply);
  }
  assert.strictEqual(chk({ reply: 'Your tracking number is coming.', calls: [{ action: 'ship', status: 'done', id: 'x1' }] }).verdict, 'pass');
});
t14('conditional wording is a disclosure, not a claim', () => {
  for (const reply of [
    "Once it's processed we'll email you.",
    "Once the refund is processed, you'll see the credit in 3-5 days.",
    'If approved, the credit will appear on your card in 3 to 5 days.',
    "When the refund clears you'll see the credit on your statement.",
    'You will receive a confirmation email once your refund is approved.',
    "As soon as it ships, you'll get a tracking number.",
    'Pending review, the refund will appear on your card.',
    "You'll see the credit in 3-5 days after we receive the return.",
    'Your refund is subject to approval, and the credit will appear on your card.',
  ]) {
    const out = chk({ reply, calls: declined });
    assert.strictEqual(out.claims, 0, reply);
    assert.strictEqual(out.verdict, 'pass', reply);
  }
  const d = chk({ reply: 'If approved, the credit will appear on your card in 3 to 5 days.', calls: declined });
  assert.deepStrictEqual(d.disclosures.map((x) => [x.kind, x.action]), [['conditional', 'pay']]);
  assert.ok(d.report.includes('only on a condition'), d.report);
});
t14('negated, hedged and question wording is not a claim', () => {
  for (const reply of [
    "You won't see the credit because the refund failed.",
    'The credit will not appear on your card yet.',
    'You may see the credit in 3-5 days.',
    'It might appear on your card later this week.',
    'Will I see the credit on my statement?',
    "I couldn't refund order 185, so you won't see the credit.",
    'No confirmation email is on its way yet.',
    "We'll send you a confirmation email.",
    'I will refund it tomorrow.',
  ]) {
    const out = chk({ reply, calls: declined });
    assert.strictEqual(out.claims, 0, reply);
    assert.strictEqual(out.verdict, 'pass', reply);
  }
});
t14('honest failure replies stay clean', () => {
  const out = chk({ reply: 'The refund for order 185 was declined by the bank, so I have passed it to a person on our team.', calls: declined });
  assert.strictEqual(out.claims, 0);
  assert.strictEqual(out.verdict, 'pass');
});
t14('ship is an action alias', () => {
  assert.strictEqual(L13.normalizeCall({ action: 'shipment' }).action, 'ship');
  assert.strictEqual(L13.normalizeCall({ action: 'fulfill' }).action, 'ship');
});
assert.strictEqual(L13.VERSION, '1.4.0');
console.log(`v1.4.0 cases passed: ${n14}`);

// Cross-check a few cases against the Python package when it is installed
if (fs.existsSync(path.join(OSS, 'saydo_diff'))) {
// Cross-check a few cases against the Python package
function py(message, log) {
  const script = `
import json, sys
sys.path.insert(0, "/workspace/products/say-do-diff-oss")
from saydo_diff import diff, extract_claims, grade_call
msg = json.loads(sys.argv[1])
log = json.loads(sys.argv[2])
r = diff(msg, log)
print(json.dumps({
  "verbs": [c.verb for c in extract_claims(msg)],
  "stop_ship": r.stop_ship,
  "gaps": len(r.gaps),
  "claims": len(r.findings),
  "findings": [{"status": f.status, "grade": f.grade, "reason": f.reason, "verb": f.claim.verb} for f in r.findings],
  "dupes": len(r.duplicates),
  "text": r.to_text(),
}))
`;
  const res = spawnSync('python3', ['-c', script, JSON.stringify(message), JSON.stringify(log)], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr || res.stdout);
  return JSON.parse(res.stdout);
}

const cross = [
  ['I sent the proposal to dana@acme.com.', [{ tool: 'mail', action: 'send', target: 'dana@acme.com', status: 'done', id: 'm1' }]],
  ['I booked the room.', []],
  ['I sent it.', [{ action: 'send', http_status: 202 }]],
  ['I refunded $45 for order 88412.', [{ action: 'pay', target: 'order 88412', amount: 40, status: 'done', id: 're_1' }]],
  ['All set!', [{ tool: 'cal', action: 'book', status: 'pending' }]],
  [replyText(ex, nodeMap), calls],
  ["I will send the report tomorrow. I haven't booked the room yet.", []],
];
for (const [msg, log] of cross) {
  const js = diff(msg, log);
  const p = py(msg, log);
  const jsF = js.findings.map((f) => ({ status: f.status, grade: f.grade, reason: f.reason, verb: f.claim.verb }));
  assert.deepStrictEqual(jsF, p.findings, `cross findings for: ${msg.slice(0, 60)}\nJS ${JSON.stringify(jsF)}\nPY ${JSON.stringify(p.findings)}`);
  assert.strictEqual(js.stop_ship, p.stop_ship);
  assert.strictEqual(js.duplicates.length, p.dupes);
}

console.log('python cross-check passed');
} else {
  console.log('python cross-check skipped (Say-Do Diff package not found)');
}

console.log('all saydo_check tests passed');
