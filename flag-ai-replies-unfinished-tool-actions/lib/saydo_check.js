/**
 * Code-node port of Say-Do Diff (saydo_diff.core + examples/n8n/n8n_to_log).
 * Standard JavaScript only. Read-only: reports gaps, never edits a reply.
 * Version 1.2.0: also extracts passive and noun phrasings, and can grade
 * an optional structured actions array against the tool log.
 * Version 1.3.0: partial batch results (48 created, 2 failed) are graded P,
 * claims bind to the tool call for the same order, recipient or amount,
 * "couldn't" and "pending" statements are reported as disclosures, and
 * malformed input fails with a clear message.
 * Version 1.4.0: implied completion. A future tense consequence of an
 * action ("you'll see the credit on your statement in 3-5 days", "a
 * confirmation email is on its way", "your tracking number is coming")
 * is a claim that the action happened, and is graded against the tool log.
 * Conditional, negated or hedged wording ("once it's processed", "if
 * approved", "may") is listed as a disclosure instead.
 *
 * Evidence grades (lowest to highest, plus failed):
 *   S0  no tool call recorded for the claim
 *   S1  call made, but error / timeout / unknown result
 *   S2  accepted or queued, or "done" with no object id
 *   S3  done, with an object id (message id, event id, charge id)
 *   S4  verified afterwards (delivered webhook, read-back)
 *   P   partial: HTTP 200 but the body shows some items failed
 *       (between S2 and S3; never enough for a completed claim)
 *   F   provider reported failure (bounce, 4xx/5xx, payment_failed,
 *       or an HTTP 200 body that reports failure)
 */
'use strict';

const RANK = { F: -1, S0: 0, S1: 1, S2: 2, P: 2.5, S3: 3, S4: 4 };

const VERBS = {
  send: ['sent', 'emailed', 'mailed', 'forwarded', 'texted', 'messaged', 'notified', 'replied', 'submitted', 'invited', 'shared'],
  create: ['created', 'added', 'opened', 'logged', 'filed', 'registered', 'saved', 'uploaded', 'generated'],
  update: ['updated', 'changed', 'edited', 'modified', 'marked', 'moved', 'renamed', 'assigned', 'closed', 'resolved', 'archived', 'merged', 'approved', 'enabled', 'disabled'],
  delete: ['deleted', 'removed', 'erased', 'purged', 'wiped'],
  book: ['booked', 'scheduled', 'reserved', 'rescheduled'],
  pay: ['paid', 'refunded', 'charged', 'transferred', 'reimbursed', 'credited', 'wired', 'invoiced'],
  post: ['posted', 'published', 'tweeted', 'deployed', 'released'],
  cancel: ['canceled', 'cancelled', 'unsubscribed', 'revoked', 'voided'],
};
const VERIFIED_WORDS = new Set(['delivered', 'confirmed', 'verified', 'settled']);
const FORM_TO_ACTION = {};
for (const [action, forms] of Object.entries(VERBS)) {
  for (const form of forms) FORM_TO_ACTION[form] = action;
}
FORM_TO_ACTION.delivered = 'send';
FORM_TO_ACTION.settled = 'pay';

const VERSION = '1.4.0';

const ACTION_ALIASES = {
  refund: 'pay', refunds: 'pay', reimbursement: 'pay', reimbursements: 'pay',
  payment: 'pay', payments: 'pay', charge: 'pay', transfer: 'pay',
  invoice: 'pay', credit: 'pay',
  email: 'send', mail: 'send', message: 'send', notify: 'send',
  invite: 'send', invitation: 'send', text: 'send',
  cancel: 'cancel', cancellation: 'cancel',
  delete: 'delete', deletion: 'delete', remove: 'delete',
  book: 'book', booking: 'book', schedule: 'book', reservation: 'book',
  create: 'create', update: 'update', post: 'post',
  ship: 'ship', shipment: 'ship', shipping: 'ship', fulfill: 'ship', fulfil: 'ship',
  fulfillment: 'ship', fulfilment: 'ship', create_shipment: 'ship', create_label: 'ship',
};
for (const [action, forms] of Object.entries(VERBS)) {
  ACTION_ALIASES[action] = action;
  for (const form of forms) ACTION_ALIASES[form] = action;
}
for (const [form, action] of Object.entries(FORM_TO_ACTION)) {
  ACTION_ALIASES[form] = action;
}

const UMBRELLA = [
  'all set', 'all done', 'taken care of', 'took care of', 'good to go', 'squared away',
  'everything is done', 'everything is complete', 'everything is in place', "you're set",
  'you are set', 'wrapped up',
];
const BLOCKERS = new Set([
  'will', "i'll", "we'll", 'shall', 'going', 'gonna', 'plan', 'planning', 'about', 'can', 'could',
  'should', 'would', 'might', 'may', 'must', 'let', 'want', 'ready', 'need', 'needs', 'if', 'unless',
  'once', 'when', 'whether', 'try', 'trying', 'not', 'never', "didn't", "haven't", "hasn't",
  "wasn't", "weren't", "isn't", "aren't", "couldn't", "won't", 'yet', 'you', 'they', 'he', 'she',
  "can't", 'cannot', "don't", "doesn't", 'unable', 'failed', 'without', 'hopefully', "shouldn't",
  "wouldn't", 'nor', 'neither',
]);
// A sentence that is only "Done." (or "It's done!") claims everything in the run.
const BARE_DONE_RE = /^(?:(?:it's|it is|that's|that is|all|everything's|everything is)\s+)?(?:done|completed|finished|sorted|handled)\s*[.!\u2705\s]*$/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, both: 2 };

const FAILED = new Set(['failed', 'failure', 'error', 'bounced', 'bounce', 'dropped', 'rejected', 'declined', 'payment_failed', 'canceled_by_provider']);
const ATTEMPTED = new Set(['timeout', 'timed_out', 'unknown', 'attempted', 'no_response']);
const ACCEPTED = new Set(['accepted', 'queued', 'pending', 'processing', 'scheduled_send', 'in_progress']);
const REVERSAL = new Set(['bounced', 'bounce', 'returned', 'reversed', 'chargeback', 'disputed', 'refund_failed', 'payment_failed', 'undeliverable']);
const DONE = new Set(['done', 'ok', 'success', 'succeeded', 'sent', 'created', 'completed', 'booked', 'paid']);
const VERIFIED = new Set(['verified', 'delivered', 'confirmed', 'settled', 'read_back']);

const DEFAULT_FAILURE_MARKERS = [
  'ok:false', 'success:false', 'succeeded:false',
  'status:error', 'status:failed', 'status:failure',
  'error', 'errors',
];
const BODY_WRAPPER_KEYS = ['body', 'data', 'json', 'result', 'response', 'output'];

function isNormalizedMarkers(markers) {
  return Array.isArray(markers) && markers.every((m) => m && typeof m === 'object' && m.kind && m.key);
}

function parseMarkerItem(item) {
  if (item && typeof item === 'object' && !Array.isArray(item) && item.key) {
    if (item.kind) return { kind: item.kind, key: String(item.key), values: item.values };
    if (item.equals !== undefined) return { kind: 'equals', key: String(item.key), values: [String(item.equals).toLowerCase()] };
    if (item.nonempty) return { kind: 'nonempty', key: String(item.key) };
    if (Object.prototype.hasOwnProperty.call(item, 'equals_false') || item.false === true) {
      return { kind: 'false', key: String(item.key) };
    }
    return { kind: 'present', key: String(item.key) };
  }
  const s = String(item == null ? '' : item).trim();
  if (!s) return null;
  const colon = s.indexOf(':');
  if (colon <= 0) {
    const key = s;
    if (key.toLowerCase() === 'errors') return { kind: 'nonempty', key };
    return { kind: 'present', key };
  }
  const key = s.slice(0, colon).trim();
  const val = s.slice(colon + 1).trim();
  const vlow = val.toLowerCase();
  if (vlow === 'false') return { kind: 'false', key };
  if (vlow === 'true') return { kind: 'true', key };
  if (vlow === 'present') return { kind: 'present', key };
  if (vlow === 'nonempty') return { kind: 'nonempty', key };
  return { kind: 'equals', key, values: [vlow] };
}

function parseMarkerList(items) {
  return (items || []).map(parseMarkerItem).filter(Boolean);
}

function parseMarkerObject(obj) {
  const out = [];
  for (const key of obj.falseKeys || []) out.push({ kind: 'false', key: String(key) });
  for (const key of obj.trueKeys || []) out.push({ kind: 'true', key: String(key) });
  const statusValues = (obj.statusValues || []).map((v) => String(v).toLowerCase());
  if (statusValues.length) out.push({ kind: 'equals', key: obj.statusKey || 'status', values: statusValues });
  for (const key of obj.presentKeys || []) out.push({ kind: 'present', key: String(key) });
  for (const key of obj.nonemptyKeys || []) out.push({ kind: 'nonempty', key: String(key) });
  return out;
}

/**
 * Missing or blank Config uses the built in list. An explicit empty array
 * means "do not treat response bodies as failure" (HTTP 4xx/5xx and a
 * failed status string still apply).
 */
function normalizeFailureMarkers(raw) {
  if (isNormalizedMarkers(raw)) return raw;
  if (raw == null) return parseMarkerList(DEFAULT_FAILURE_MARKERS);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return parseMarkerList(DEFAULT_FAILURE_MARKERS);
    const parsed = parseMaybeJson(s);
    if (parsed === undefined) {
      const parts = s.includes(',') ? s.split(',').map((x) => x.trim()).filter(Boolean) : [s];
      return parseMarkerList(parts);
    }
    raw = parsed;
  }
  if (Array.isArray(raw)) return parseMarkerList(raw);
  if (raw && typeof raw === 'object') return parseMarkerObject(raw);
  return parseMarkerList(DEFAULT_FAILURE_MARKERS);
}

function fieldLookup(obj, key) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { found: false };
  if (Object.prototype.hasOwnProperty.call(obj, key)) return { found: true, value: obj[key] };
  const lower = String(key).toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return { found: true, value: obj[k] };
  }
  return { found: false };
}

function isExplicitFalse(v) {
  if (v === false || v === 0) return true;
  if (typeof v === 'string') return ['false', '0', 'no'].includes(v.trim().toLowerCase());
  return false;
}

function isExplicitTrue(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
  return false;
}

function isPresent(v) {
  if (v == null || v === false || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function isNonempty(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'string') return v.trim() !== '';
  return isPresent(v);
}

function matchesMarker(obj, marker) {
  const { found, value } = fieldLookup(obj, marker.key);
  if (!found) return false;
  switch (marker.kind) {
    case 'false': return isExplicitFalse(value);
    case 'true': return isExplicitTrue(value);
    case 'equals': {
      const s = String(value).toLowerCase().trim();
      return (marker.values || []).some((v) => v === s);
    }
    case 'present': return isPresent(value);
    case 'nonempty': return isNonempty(value);
    default: return false;
  }
}

function objectsToScan(call) {
  const out = [];
  const seen = new Set();
  function add(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (seen.has(obj)) return;
    seen.add(obj);
    out.push(obj);
  }
  add(call);
  function walk(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 2) return;
    for (const k of BODY_WRAPPER_KEYS) {
      const { found, value } = fieldLookup(obj, k);
      if (found) {
        add(value);
        walk(value, depth + 1);
      }
    }
  }
  walk(call, 0);
  return out;
}

function callReportsFailure(call, markers) {
  const rules = isNormalizedMarkers(markers) ? markers : normalizeFailureMarkers(markers);
  if (!rules.length) return false;
  const objs = objectsToScan(call);
  for (const obj of objs) {
    for (const m of rules) {
      // Top level call.error is the existing S1 channel (timeout, node error).
      // A nested body.error is a provider failure and is still checked.
      if (obj === call && m.kind === 'present' && String(m.key).toLowerCase() === 'error') continue;
      if (matchesMarker(obj, m)) return true;
    }
  }
  return false;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const MONEY_RE = /[$€£¥₹]\s?(\d[\d,]*(?:\.\d+)?)/g;
const ID_RE = /(?<![$\w.])#?(\d{3,})(?!\w|\.\d)/g;
const QUOTED_RE = /["“']([^"”']{2,60})["”']/g;
// A count is a number before a plural noun ("all 50 invites"), not an id
// ("order #185 has") and not an auxiliary verb ending in s.
const COUNT_RE = new RegExp('(?<![#\\w])(?<!\\b(?:order|invoice|ticket|case|id|no\\.?|number|room|account)\\s)(?:all\\s+)?(\\d+|' + Object.keys(NUMBER_WORDS).join('|') + ')\\s+(?:of\\s+the\\s+)?(?!(?:has|was|is|this|his|its|yes|plus|does|thus|as|us|business|seconds|minutes|hours|days|weeks|months|years)\\b)[a-z]+s\\b', 'i');
const WORD_RE = /[A-Za-z']+|\u2705/g;

// Phrasings a commenter on r/n8n showed the verb list missed. Conservative:
// noun plus a completed auxiliary, not a bare adjective.
const PHRASE_RULES = [
  {
    re: /\b(?:(?:your|the|a|an)\s+)?refunds?\s+(?:(?:has|have|had)\s+been|was|were|is|are|got)\s+processed\b/i,
    action: 'pay',
    verb: 'processed',
  },
  {
    re: /\b(?:(?:has|have|had)\s+been|was|were|got)\s+processed\b/i,
    action: 'pay',
    verb: 'processed',
    require: /\b(refunds?|payments?|reimbursements?|charges?|credits?)\b/i,
  },
  {
    re: /\b(?:the\s+)?(?:money|funds|payment|refund)\s+(?:is|are|was|were|(?:has|have|had)\s+been)\s+back\s+on\s+(?:your|the)\s+card\b/i,
    action: 'pay',
    verb: 'refunded',
  },
  {
    re: /\bgot\s+(?:the\s+)?(?:refund|payment|reimbursement)\s+issued\b/i,
    action: 'pay',
    verb: 'issued',
  },
  {
    re: /\b(?:the\s+)?(?:refund|payment|reimbursement)\s+(?:(?:has|have|had)\s+been|was|were|is|got)\s+issued\b/i,
    action: 'pay',
    verb: 'issued',
  },
  {
    re: /^(?:(?:your|the|all|both)\s+)?(?:\d+\s+)?(?:refund|reimbursement|payment|credit)s?\s+(?:issued|processed|completed|done)\b/i,
    action: 'pay',
    verb: 'issued',
  },
  {
    re: /\b(?:the\s+)?(?:invite|invitation)\s+is\s+out\b/i,
    action: 'send',
    verb: 'invited',
  },
];

// v1.4.0: implied completion (reported on r/n8n: "you'll see the credit on
// your statement in 3-5 days" after a failed refund graded clean). A future
// tense consequence only makes sense if the action already happened, so it
// is a claim of that action. `kind` names the implied action in the report.
// `hint` narrows the tool calls that can back the claim when the log has them.
const MONEY_NOUN = '(?:full\\s+|partial\\s+)?(?:credit|refund|reimbursement|money|funds|payment|amount)';
const IMPLIED_RULES = [
  // pay: the customer will see the money
  { kind: 'refund', action: 'pay', re: new RegExp(`\\b(?:you'll|you will|you should|you'd|expect to)\\s+(?:see|receive|get|notice)\\s+(?:the\\s+|your\\s+|a\\s+|an\\s+|that\\s+|this\\s+)?${MONEY_NOUN}s?\\b`, 'i') },
  { kind: 'refund', action: 'pay', re: new RegExp(`\\b(?:the|your|this|that|a|an)\\s+${MONEY_NOUN}s?\\s+(?:will|should)\\s+(?:appear|show(?:\\s+up)?|post|land|arrive|reflect|hit|clear|go\\s+through|be\\s+(?:back|visible|returned|credited|reflected|on|in|available))\\b`, 'i') },
  { kind: 'charge', action: 'pay', re: /\b(?:the|this|that|a|an)\s+charge\s+(?:will|should)\s+(?:appear|show(?:\s+up)?|post|be\s+(?:visible|reflected|on))\b/i },
  { kind: 'refund', action: 'pay', re: /\b(?:it|this|that)\s+(?:will|should)\s+(?:appear|show(?:\s+up)?|post|be\s+(?:back|visible|reflected))\s+(?:on|in)\s+(?:your|the)\s+(?:card|statement|bank|account|balance)\b/i },
  { kind: 'refund', action: 'pay', re: new RegExp(`\\b(?:the|your)\\s+${MONEY_NOUN}s?\\s+(?:is|are)\\s+(?:on\\s+(?:its|their|the)\\s+way|headed\\s+(?:your|back)|coming\\s+back)\\b`, 'i') },
  { kind: 'refund', action: 'pay', re: /\b(?:will|should)\s+be\s+(?:refunded|credited|returned|reimbursed)\s+(?:back\s+)?(?:to|on)\s+(?:your|the)\s+(?:card|account|original|statement|bank|payment)\b/i },
  { kind: 'refund', action: 'pay', re: /\b(?:you'll|you will|you should)\s+be\s+(?:refunded|credited|reimbursed)\b/i },
  { kind: 'refund', action: 'pay', re: new RegExp(`\\ballow\\s+(?:\\d+|[a-z]+)(?:\\s*(?:-|to)\\s*\\d+)?\\s+(?:business\\s+|working\\s+)?days\\s+for\\s+(?:the|your)\\s+${MONEY_NOUN}\\b`, 'i') },
  // send: an email or message is on its way
  { kind: 'email', action: 'send', hint: 'email', re: /\b(?:a|an|the|your)\s+(?:confirmation\s+|follow[- ]up\s+|receipt\s+)?(?:email|e-mail|receipt|confirmation|invite|invitation|message|text|sms)\s+(?:is|has\s+been)\s+(?:on\s+(?:its|the)\s+way|headed\s+your\s+way|coming\s+your\s+way)\b/i },
  { kind: 'email', action: 'send', hint: 'email', re: /\b(?:a|an|the|your)\s+(?:confirmation\s+|follow[- ]up\s+)?(?:email|e-mail|receipt|confirmation|invite|invitation)\s+(?:is|should\s+be|will\s+be)\s+in\s+your\s+inbox\b/i },
  { kind: 'email', action: 'send', hint: 'email', re: /\b(?:you'll|you will|you should)\s+(?:receive|get|see)\s+(?:a|an|the|your)\s+(?:confirmation(?:\s+(?:email|e-mail|message|text))?|(?:follow[- ]up\s+)?(?:email|e-mail)|receipt|invite|invitation)\b/i },
  { kind: 'email', action: 'send', hint: 'email', re: /\bcheck\s+your\s+(?:inbox|email)\s+for\b/i },
  // ship: a shipment exists
  { kind: 'shipment', action: 'ship', re: /\b(?:a|the|your)\s+tracking\s+(?:number|link|code|info(?:rmation)?|details)\s+(?:is\s+|are\s+|will\s+be\s+|should\s+be\s+)?(?:on\s+(?:its|the)\s+way|coming|(?:sent|emailed|texted)\b|headed)/i },
  { kind: 'shipment', action: 'ship', re: /\b(?:you'll|you will|you should)\s+(?:receive|get)\s+(?:a|an|the|your)\s+tracking\s+(?:number|link|code|email)\b/i },
  { kind: 'shipment', action: 'ship', re: /\b(?:your|the)\s+(?:order|package|parcel|shipment|replacement|item|items)\s+(?:is|are|has\s+been)\s+on\s+(?:its|their|the)\s+way\b/i },
  { kind: 'shipment', action: 'ship', re: /\b(?:your|the)\s+(?:order|package|parcel|shipment|replacement)\s+(?:will|should)\s+(?:arrive|be\s+delivered|be\s+there|reach\s+you)\s+(?:in|within|by|on|tomorrow|today|this|next)\b/i },
];
// Wording that keeps an implied consequence from being a claim.
const IMPLIED_CONDITION_RE = /\b(?:if|once|when|whenever|after|as\s+soon\s+as|unless|until|pending|subject\s+to|upon|provided|assuming|in\s+case|approval|approved|eligible)\b/i;
const IMPLIED_HEDGE_RE = /\b(?:may|might|could|possibly|hopefully|probably|perhaps)\b/i;
const IMPLIED_NEGATION_RE = /\b(?:not|never|no)\b|n't\b|\bcannot\b/i;
const EMAIL_TOOL_RE = /mail|smtp|sendgrid|\bses\b|postmark|mailgun|resend|mailchimp|brevo|sendinblue/i;
const CHAT_TOOL_RE = /slack|discord|teams|telegram|whatsapp|\bsms\b|twilio|mattermost/i;
const SHIP_TOOL_RE = /ship|fulfil|tracking|parcel|shippo|easypost|shipstation|\bfedex\b|\busps\b|\bdhl\b|\bups\b|courier/i;

function impliedHits(sent) {
  const out = [];
  const used = [];
  for (const rule of IMPLIED_RULES) {
    const m = rule.re.exec(sent);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (used.some(([a, b]) => start < b && end > a)) continue;
    used.push([start, end]);
    out.push({ rule, start, end, text: m[0] });
  }
  return out;
}

function impliedGuard(sent, hit) {
  if (/\?\s*$/.test(sent)) return 'question';
  const window = sent.slice(Math.max(0, hit.start - 16), hit.end);
  if (IMPLIED_NEGATION_RE.test(window)) return 'negated';
  if (IMPLIED_CONDITION_RE.test(sent)) return 'conditional';
  if (IMPLIED_HEDGE_RE.test(window)) return 'conditional';
  return null;
}

function extractImpliedClaims(sent, existing, earlier) {
  const added = [];
  for (const hit of impliedHits(sent)) {
    if (impliedGuard(sent, hit)) continue;
    const { rule } = hit;
    if (existing.concat(added).some((c) => !c.umbrella && c.action === rule.action && c.sentence === sent)) continue;
    // "in 3-5 days" or "within 120 days" is a time span, not an order id.
    const details = detailsFrom(sent.replace(/\b\d+(?:\s*(?:-|to|\u2013)\s*\d+)?\s+(?:business\s+|working\s+|bank\s+)?(?:days?|hours?|weeks?|minutes?)\b/gi, ' '));
    // "Refund for order 185 issued. You'll see the credit in 3-5 days." is one claim.
    if (!details.targets.length && details.amount == null
      && earlier.some((c) => !c.umbrella && c.action === rule.action)) continue;
    added.push({
      sentence: sent,
      verb: 'implied',
      action: rule.action,
      needs: 'S3',
      targets: details.targets,
      amount: details.amount,
      currency: details.currency,
      count: null,
      umbrella: false,
      implied: rule.kind,
      hint: rule.hint || null,
    });
  }
  return added;
}

function extractImpliedDisclosures(sent) {
  const out = [];
  for (const hit of impliedHits(sent)) {
    const why = impliedGuard(sent, hit);
    if (why === 'conditional' || why === 'negated') {
      out.push({ sentence: sent, kind: why === 'negated' ? 'not_done' : 'conditional', action: hit.rule.action, verb: `implied ${hit.rule.kind}` });
    }
  }
  return out;
}

// v1.3.0: batch and bulk responses that report mixed results (reported on
// r/n8n: HTTP 200 with {"created":48,"failed":2} was graded as finished).
// Editable from Config.partialRules: countPairs are [successKey, failureKey]
// pairs read as numbers (an array counts as its length); itemArrays name
// lists whose items carry status, ok, success or error fields.
const DEFAULT_PARTIAL_RULES = {
  countPairs: [
    ['created', 'failed'], ['succeeded', 'failed'], ['succeeded', 'errors'],
    ['successful', 'failed'], ['success_count', 'failure_count'], ['successCount', 'failureCount'],
    ['success_count', 'error_count'], ['successCount', 'errorCount'], ['sent', 'failed'],
    ['delivered', 'failed'], ['processed', 'failed'], ['accepted', 'rejected'],
    ['inserted', 'failed'], ['updated', 'failed'], ['imported', 'failed'], ['completed', 'failed'],
    ['ok', 'failed'], ['ok', 'errors'], ['passed', 'failed'],
  ],
  itemArrays: ['results', 'items', 'responses', 'replies', 'data', 'entries', 'records', 'messages', 'operations', 'statuses', 'outcomes'],
};
const ITEM_FAIL_STATUS = new Set([...FAILED, 'error', 'errored', 'failure', 'fail', 'invalid', 'denied', 'not_found', 'conflict']);
const ITEM_OK_STATUS = new Set([...DONE, ...VERIFIED, 'created', 'updated', 'deleted', 'ok', 'success', 'successful']);
const ITEM_PENDING_STATUS = new Set([...ACCEPTED, ...ATTEMPTED]);

function normalizePartialRules(raw) {
  if (raw && raw._normalized) return raw;
  let r = raw;
  if (typeof r === 'string') {
    const t = r.trim();
    r = t ? parseMaybeJson(t) : undefined;
    if (t && r === undefined) throw new Error('Could not read "partialRules": it is not valid JSON.');
  }
  if (r == null) r = DEFAULT_PARTIAL_RULES;
  if (Array.isArray(r)) r = { countPairs: r };
  if (typeof r !== 'object') r = DEFAULT_PARTIAL_RULES;
  const countPairs = (Array.isArray(r.countPairs) ? r.countPairs : DEFAULT_PARTIAL_RULES.countPairs)
    .filter((pair) => Array.isArray(pair) && pair.length >= 2)
    .map((pair) => [String(pair[0]), String(pair[1])]);
  const itemArrays = (Array.isArray(r.itemArrays) ? r.itemArrays : DEFAULT_PARTIAL_RULES.itemArrays).map(String);
  return { countPairs, itemArrays, _normalized: true };
}

function countOf(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

function numericStatus(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*\d{3}\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

function itemOutcome(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  let ok = false;
  for (const k of ['ok', 'success', 'succeeded']) {
    const { found, value } = fieldLookup(it, k);
    if (!found || typeof value === 'number') continue;
    if (isExplicitFalse(value)) return 'fail';
    if (isExplicitTrue(value)) ok = true;
  }
  for (const k of ['error', 'errors']) {
    const { found, value } = fieldLookup(it, k);
    if (found && isNonempty(value) && value !== false) return 'fail';
  }
  for (const k of ['status', 'statusCode', 'status_code', 'http_status', 'code']) {
    const { found, value } = fieldLookup(it, k);
    if (!found || value == null) continue;
    const n = numericStatus(value);
    if (n != null && n >= 100 && n < 600) {
      if (n >= 400) return 'fail';
      if (n === 202) return 'pending';
      if (n >= 200 && n < 300) ok = true;
      continue;
    }
    if (typeof value !== 'string') continue;
    const st = value.toLowerCase().trim();
    if (ITEM_FAIL_STATUS.has(st)) return 'fail';
    if (ITEM_PENDING_STATUS.has(st)) return 'pending';
    if (ITEM_OK_STATUS.has(st)) ok = true;
  }
  return ok ? 'ok' : null;
}

function batchOutcome(call, partialRules, includeClean) {
  const rules = normalizePartialRules(partialRules);
  const objs = objectsToScan(call);
  for (const obj of objs) {
    for (const [sk, fk] of rules.countPairs) {
      const a = fieldLookup(obj, sk);
      const b = fieldLookup(obj, fk);
      if (!a.found || !b.found) continue;
      const succeeded = countOf(a.value);
      const failed = countOf(b.value);
      if (succeeded == null || failed == null) continue;
      if (failed === 0 && !includeClean) continue;
      return { succeeded, failed, pending: 0, total: succeeded + failed, field: `${sk}/${fk}` };
    }
  }
  const arrays = [];
  if (Array.isArray(call.body)) arrays.push(['body', call.body]);
  for (const obj of objs) {
    for (const k of rules.itemArrays) {
      const { found, value } = fieldLookup(obj, k);
      if (found && Array.isArray(value)) arrays.push([k, value]);
    }
  }
  for (const [k, arr] of arrays) {
    let succeeded = 0;
    let failed = 0;
    let pending = 0;
    let unknown = 0;
    for (const it of arr) {
      const o = itemOutcome(it);
      if (o === 'ok') succeeded += 1;
      else if (o === 'fail') failed += 1;
      else if (o === 'pending') pending += 1;
      else unknown += 1;
    }
    if (failed + pending === 0 && !(includeClean && succeeded > 0)) continue;
    return { succeeded, failed, pending, unknown, total: arr.length, field: `${k}[]` };
  }
  return null;
}

function describeBatch(b) {
  let s = `${b.succeeded} of ${b.total} succeeded, ${b.failed} failed`;
  if (b.pending) s += `, ${b.pending} pending`;
  if (b.unknown) s += `, ${b.unknown} unclear`;
  return `${s} (${b.field})`;
}

const HTTP_KEYS = ['http_status', 'httpStatus', 'status_code', 'statusCode', 'http_code'];
const MONEY_SYMBOLS = { '$': 'usd', '€': 'eur', '£': 'gbp', '¥': 'jpy', '₹': 'inr' };
const CURRENCY_CODES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy', 'inr', 'chf', 'nzd', 'sgd', 'mxn', 'brl', 'sek', 'nok', 'dkk', 'pln', 'zar'];
const CODE_MONEY_RE = new RegExp(`\\b(?:(${CURRENCY_CODES.join('|')})\\s?(\\d[\\d,]*(?:\\.\\d+)?)|(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${CURRENCY_CODES.join('|')}|dollars?|euros?|pounds?))\\b`, 'i');

function parseAmount(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function currencyOf(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  for (const [sym, code] of Object.entries(MONEY_SYMBOLS)) if (s.includes(sym)) return code;
  const m = s.match(new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`));
  return m ? m[1] : null;
}

/** Copies a raw log entry into the shape the grader reads. Returns null for non-objects. */
function normalizeCall(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const call = { ...raw };
  call.action = normalizeAction(call.action == null ? '' : call.action);
  if (call.http_status == null || numericStatus(call.http_status) == null) {
    for (const k of HTTP_KEYS) {
      const n = numericStatus(call[k]);
      if (n != null) { call.http_status = n; break; }
    }
    if (call.http_status == null && numericStatus(call.status) != null) call.http_status = numericStatus(call.status);
  } else {
    call.http_status = numericStatus(call.http_status);
  }
  if (numericStatus(call.status) != null) delete call.status;
  const args = callArgs(call);
  if (args && (call.amount == null || call.amount === '') && call.amount_cents == null) {
    if (args.amount != null) call.amount = args.amount;
    else if (args.amount_cents != null) call.amount_cents = args.amount_cents;
    if (call.currency == null && args.currency != null) call.currency = args.currency;
  }
  const unit = String(call.amount_unit || call.amountUnit || '').toLowerCase();
  let amount = null;
  if (call.amount_cents != null || call.amount_minor != null) {
    const c = parseAmount(call.amount_cents != null ? call.amount_cents : call.amount_minor);
    if (c != null) amount = c / 100;
  } else if (call.amount != null && call.amount !== '') {
    amount = parseAmount(call.amount);
    if (amount != null && ['cents', 'cent', 'minor'].includes(unit)) amount /= 100;
  }
  if (call.currency == null && call.amount != null) {
    const cur = currencyOf(call.amount);
    if (cur) call.currency = cur;
  }
  if (call.currency != null) call.currency = String(call.currency).toLowerCase().trim();
  if (amount != null) call.amount = amount;
  return call;
}

function gradeCall(call, markers, partialRules) {
  const g = String(call.grade || '').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(RANK, g)) return g;
  const rules = isNormalizedMarkers(markers) ? markers : normalizeFailureMarkers(markers);
  const status = String(call.status || '').toLowerCase().trim();
  const http = numericStatus(call.http_status);
  const hasId = Boolean(call.id || call.object_id);
  if (FAILED.has(status) || (typeof http === 'number' && http >= 400)) return 'F';
  const batch = batchOutcome(call, partialRules);
  if (batch) {
    if (batch.succeeded === 0 && batch.failed > 0) return 'F';
    if (batch.succeeded > 0) return 'P';
  }
  if (callReportsFailure(call, rules)) return 'F';
  if (call.error || ATTEMPTED.has(status)) return 'S1';
  if (VERIFIED.has(status) || call.verified === true) return 'S4';
  if (ACCEPTED.has(status) || http === 202) return 'S2';
  if (DONE.has(status) || (typeof http === 'number' && http >= 200 && http < 300)) return hasId ? 'S3' : 'S2';
  return 'S1';
}

function unwrapLog(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['calls', 'toolLog', 'tool_log']) if (Array.isArray(data[k])) return data[k];
    if (data.action != null || data.tool != null) return [data];
    return [];
  }
  return [];
}

function failureDetail(call) {
  const parts = [];
  const http = numericStatus(call.http_status);
  if (http != null && http >= 400) parts.push(`HTTP ${http}`);
  const st = String(call.status || '').toLowerCase().trim();
  if (st && FAILED.has(st)) parts.push(st);
  for (const obj of objectsToScan(call)) {
    if (obj === call) continue;
    const { found, value } = fieldLookup(obj, 'error');
    if (!found || !isPresent(value)) continue;
    const text = typeof value === 'object' ? (value.code || value.message || value.type || '') : value;
    if (text) { parts.push(String(text).slice(0, 80)); break; }
  }
  return parts.join(', ');
}

function loadLog(source, markers, partialRules) {
  const rules = isNormalizedMarkers(markers) ? markers : normalizeFailureMarkers(markers);
  const pRules = normalizePartialRules(partialRules);
  let data;
  if (Array.isArray(source) || (source && typeof source === 'object')) data = unwrapLog(source);
  else {
    const text = source == null ? '' : String(source).trim();
    if (!text) data = [];
    else {
      try { data = JSON.parse(text); }
      catch {
        const lines = text.split(/\n/).filter((l) => l.trim());
        data = lines.map((l, n) => {
          try { return JSON.parse(l); }
          catch { throw new Error(`Could not read "calls": line ${n + 1} is not valid JSON. Send a JSON array of tool calls or one JSON object per line.`); }
        });
      }
      data = unwrapLog(data);
    }
  }
  const calls = [];
  data.forEach((c, i) => {
    const call = normalizeCall(c);
    if (!call) return;
    call._batch = batchOutcome(call, pRules, true);
    call._grade = gradeCall(call, rules, pRules);
    call._i = i;
    if (call._grade === 'F' && !call.note) {
      const why = failureDetail(call);
      if (why) call.note = why;
    }
    calls.push(call);
  });
  // A later failure that names the same object id (a bounce or a reversed
  // charge reported after the send or refund) overrides the earlier success.
  for (const c of calls) {
    if (RANK[c._grade] < 2) continue;
    const t = targetOnly(c);
    const later = calls.find((d) => d._i > c._i && d._grade === 'F' && (!d.action || !c.action || d.action === c.action)
      && ((c.id && d.id === c.id) || (t && targetOnly(d) === t && REVERSAL.has(String(d.status || '').toLowerCase().trim()))));
    if (later) {
      c._grade = 'F';
      c.note = `entry ${later._i} later reported ${later.status || 'failure'} for ${c.id && later.id === c.id ? `id ${c.id}` : t}`;
    }
  }
  return calls;
}

function flatText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(flatText).join(' ');
  if (typeof v === 'object') return Object.values(v).map(flatText).join(' ');
  return String(v);
}

const ARG_KEYS = ['args', 'arguments', 'input', 'params', 'parameters'];

function callArgs(call) {
  for (const k of ARG_KEYS) {
    const v = call[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
}

/** The call's target, or its tool arguments when no target was logged. */
function targetSource(call) {
  if (call.target != null && call.target !== '') return call.target;
  return callArgs(call);
}

function targetOnly(call) {
  return flatText(targetSource(call)).toLowerCase().trim();
}

function targetText(call) {
  return `${flatText(targetSource(call))} ${call.id || ''} ${call.object_id || ''}`.toLowerCase().replace(/#/g, '');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-token match, so order 185 does not match 1850 and dana@acme.co
 * does not match dana@acme.com.
 */
function targetMatches(target, call) {
  const t = String(target).toLowerCase().replace(/#/g, '').trim();
  if (!t) return false;
  const re = new RegExp(`(?<![a-z0-9@_+-]|[a-z0-9]\\.)${escapeRe(t)}(?![a-z0-9@_-]|\\.[a-z0-9])`);
  return re.test(targetText(call));
}

function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/[\u2018\u2019\u02bc\uff07]/g, "'")
    .replace(/[\u201c\u201d\uff02]/g, '"')
    .replace(/\u00a0/g, ' ');
}

function sentences(text) {
  return normalizeText(text).trim()
    .split(/(?<=[.!?])\s+|(?<=[\u3002\uff01\uff1f])\s*|\n+/)
    .map((p) => p.trim()).filter(Boolean);
}

function numTok(tok) {
  return /^\d+$/.test(tok) ? parseInt(tok, 10) : NUMBER_WORDS[String(tok).toLowerCase()];
}

function allMatches(re, text) {
  const out = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = r.exec(text))) out.push(m);
  return out;
}

function detailsFrom(text) {
  const targets = allMatches(EMAIL_RE, text).map((e) => e[0].toLowerCase());
  targets.push(...allMatches(QUOTED_RE, text).map((q) => q[1].toLowerCase()));
  const stripped = text.replace(EMAIL_RE, ' ').replace(MONEY_RE, ' ').replace(new RegExp(CODE_MONEY_RE.source, 'gi'), ' ');
  targets.push(...allMatches(ID_RE, stripped).map((id) => id[1]));
  const money = new RegExp(MONEY_RE.source).exec(text);
  let amount = null;
  let currency = null;
  if (money) {
    amount = parseFloat(money[1].replace(/,/g, ''));
    currency = MONEY_SYMBOLS[money[0].trim()[0]] || null;
  } else {
    const cm2 = CODE_MONEY_RE.exec(text);
    if (cm2) {
      amount = parseFloat((cm2[2] || cm2[3]).replace(/,/g, ''));
      const unit = String(cm2[1] || cm2[4]).toLowerCase();
      if (/^dollars?$/.test(unit)) currency = null;
      else if (/^euros?$/.test(unit)) currency = 'eur';
      else if (/^pounds?$/.test(unit)) currency = 'gbp';
      else currency = unit;
    }
  }
  const cm = COUNT_RE.exec(text);
  if (cm && /^\d+$/.test(cm[1])) {
    const at = targets.indexOf(cm[1]);
    if (at >= 0) targets.splice(at, 1);
  }
  return {
    targets,
    amount,
    currency,
    count: cm ? numTok(cm[1]) : null,
  };
}

function extractPhraseClaims(sent, existing) {
  const added = [];
  const used = [];
  for (const rule of PHRASE_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    let m;
    while ((m = re.exec(sent))) {
      if (rule.require && !rule.require.test(sent)) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (used.some(([a, b]) => start < b && end > a)) continue;
      const prefix = (sent.slice(0, start).match(WORD_RE) || []).map((w) => w.toLowerCase()).slice(-6);
      if (prefix.some((p) => BLOCKERS.has(p))) continue;
      const window = sent.slice(Math.max(0, start - 12), end).toLowerCase();
      if (/\b(not|never|no)\b/.test(window) || /n['’]t\b/.test(window)) continue;
      if (existing.some((c) => !c.umbrella && c.action === rule.action && c.sentence === sent)) continue;
      const details = detailsFrom(sent);
      added.push({
        sentence: sent,
        verb: rule.verb,
        action: rule.action,
        needs: 'S3',
        targets: details.targets,
        amount: details.amount,
        currency: details.currency,
        count: details.count,
        umbrella: false,
        phrase: true,
      });
      used.push([start, end]);
    }
  }
  return added;
}

function extractClaims(text) {
  const claims = [];
  for (const sent of sentences(text)) {
    const low = sent.toLowerCase();
    const words = allMatches(WORD_RE, sent);
    const hits = [];
    const verbClaims = [];
    words.forEach((m, i) => {
      if (FORM_TO_ACTION[m[0].toLowerCase()]) hits.push([i, m]);
    });
    hits.forEach(([i, m], n) => {
      const startWord = n ? hits[n - 1][0] + 1 : 0;
      const prefix = words.slice(startWord, i).map((w) => w[0].toLowerCase()).slice(-4);
      if (prefix.some((p) => BLOCKERS.has(p))) return;
      const end = n + 1 < hits.length ? hits[n + 1][1].index : sent.length;
      const clause = sent.slice(m.index, end);
      const verb = m[0].toLowerCase();
      const action = FORM_TO_ACTION[verb];
      const needs = (VERIFIED_WORDS.has(verb) || /\b(delivered|confirmed|verified)\b/i.test(clause)) ? 'S4' : 'S3';
      const details = detailsFrom(clause);
      // Verb last ("All 50 invites sent", "Invoice #4411 sent"): read the words before it.
      const before = n === 0 ? detailsFrom(sent.slice(0, m.index)) : { targets: [], amount: null, currency: null, count: null };
      if (!details.targets.length) details.targets = before.targets;
      if (details.amount == null) { details.amount = before.amount; details.currency = before.currency; }
      if (details.count == null) details.count = before.count;
      verbClaims.push({
        sentence: sent,
        verb,
        action,
        needs,
        targets: details.targets,
        amount: details.amount,
        currency: details.currency,
        count: details.count,
        umbrella: false,
      });
    });
    claims.push(...verbClaims);
    const phraseClaims = extractPhraseClaims(sent, verbClaims);
    claims.push(...phraseClaims);
    claims.push(...extractImpliedClaims(sent, verbClaims.concat(phraseClaims), claims.filter((c) => c.sentence !== sent)));
    if (UMBRELLA.some((u) => low.includes(u)) || sent.includes('\u2705') || BARE_DONE_RE.test(sent.trim())) {
      claims.push({ sentence: sent, verb: '(umbrella)', action: '*', needs: 'S3', targets: [], amount: null, currency: null, count: null, umbrella: true });
    }
  }
  return claims;
}

// v1.3.0: statements that say an action did not happen or is still waiting.
// They are not claims. They are listed so a reviewer can see the agent was
// honest, and they never change the verdict.
const BASE_VERBS = {
  send: 'send', email: 'send', mail: 'send', text: 'send', message: 'send', notify: 'send', forward: 'send',
  reply: 'send', submit: 'send', invite: 'send', share: 'send',
  create: 'create', add: 'create', open: 'create', file: 'create', log: 'create', save: 'create', upload: 'create', generate: 'create',
  update: 'update', change: 'update', edit: 'update', modify: 'update', mark: 'update', move: 'update', assign: 'update', close: 'update', resolve: 'update', approve: 'update',
  delete: 'delete', remove: 'delete', erase: 'delete', purge: 'delete', wipe: 'delete',
  book: 'book', schedule: 'book', reserve: 'book', reschedule: 'book',
  pay: 'pay', refund: 'pay', charge: 'pay', transfer: 'pay', reimburse: 'pay', credit: 'pay', wire: 'pay', invoice: 'pay', process: 'pay', issue: 'pay',
  post: 'post', publish: 'post', tweet: 'post', deploy: 'post', release: 'post',
  cancel: 'cancel', unsubscribe: 'cancel', revoke: 'cancel', void: 'cancel',
};
const COULD_NOT_RE = /\b(?:couldn't|could not|can't|cannot|(?:was|were|am|is|are)\s+(?:unable|not able)\s+to|unable to|(?:wasn't|weren't)\s+able\s+to|failed to|did not manage to|didn't manage to|did not|didn't)\s+(?:get\s+(?:to\s+)?)?([a-z]+)/gi;
const PENDING_RE = /\b(refunds?|payments?|transfers?|invites?|invitations?|emails?|messages?|bookings?|reservations?|cancellations?|orders?|charges?)\b(?:\s+(?:for|to|of)\s+[^.!?,;]{1,40}?)?\s+(?:is|are|was|remains?|stays?)\s+(?:still\s+)?(pending|queued|processing|in progress|on hold|awaiting [a-z]+)\b|\b(refunds?|payments?|transfers?|invites?|emails?|bookings?)\s+(pending|queued)\b/gi;
const NOUN_ACTION = { refund: 'pay', payment: 'pay', transfer: 'pay', charge: 'pay', invite: 'send', invitation: 'send', email: 'send', message: 'send', booking: 'book', reservation: 'book', cancellation: 'cancel', order: 'create' };

function extractDisclosures(text) {
  const out = [];
  for (const sent of sentences(text)) {
    for (const m of allMatches(COULD_NOT_RE, sent)) {
      const action = BASE_VERBS[m[1].toLowerCase()];
      if (!action) continue;
      out.push({ sentence: sent, kind: 'not_done', action, verb: m[1].toLowerCase() });
    }
    for (const m of allMatches(PENDING_RE, sent)) {
      const noun = String(m[1] || m[3]).toLowerCase().replace(/s$/, '');
      out.push({ sentence: sent, kind: 'pending', action: NOUN_ACTION[noun] || '', verb: String(m[2] || m[4]).toLowerCase() });
    }
    for (const d of extractImpliedDisclosures(sent)) {
      if (!out.some((o) => o.sentence === sent && o.action === d.action)) out.push(d);
    }
  }
  return out;
}

function normalizeAction(raw) {
  if (raw == null) return '';
  const s = String(raw).toLowerCase().trim();
  if (!s) return '';
  if (Object.prototype.hasOwnProperty.call(VERBS, s)) return s;
  if (FORM_TO_ACTION[s]) return FORM_TO_ACTION[s];
  if (ACTION_ALIASES[s]) return ACTION_ALIASES[s];
  return s;
}

function makeStructuredClaim(item, action) {
  const verb = String((item && (item.verb || item.action || item.type)) || action || '').toLowerCase();
  const status = String((item && item.status) || '').toLowerCase().trim();
  const needs = (VERIFIED.has(status) || VERIFIED_WORDS.has(status) || VERIFIED_WORDS.has(verb)) ? 'S4' : 'S3';
  const targets = [];
  function addTarget(v) {
    if (v == null || v === '') return;
    if (Array.isArray(v)) {
      for (const x of v) addTarget(x);
      return;
    }
    if (typeof v === 'object') {
      for (const x of Object.values(v)) addTarget(x);
      return;
    }
    targets.push(String(v).toLowerCase());
  }
  if (item && typeof item === 'object') {
    addTarget(item.target);
    addTarget(item.targets);
    addTarget(item.email);
  }
  const amountRaw = item && item.amount;
  const amount = parseAmount(amountRaw);
  const currency = (item && item.currency ? String(item.currency).toLowerCase() : null) || currencyOf(amountRaw);
  const countRaw = item && item.count;
  let count = null;
  if (countRaw != null && countRaw !== '') count = numTok(countRaw) || Number(countRaw) || null;
  const sentence = (item && item.sentence)
    || [action, status, item && item.target != null ? (typeof item.target === 'object' ? JSON.stringify(item.target) : String(item.target)) : '', amountRaw != null ? String(amountRaw) : ''].filter(Boolean).join(' ');
  return {
    sentence,
    verb: verb || action,
    action,
    needs,
    targets,
    amount: Number.isFinite(amount) ? amount : null,
    currency,
    count,
    umbrella: false,
    structured: true,
  };
}

function structuredClaims(actions) {
  if (!Array.isArray(actions) || !actions.length) return [];
  const out = [];
  for (const item of actions) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const action = normalizeAction(item);
      if (!action) continue;
      out.push(makeStructuredClaim({ action, verb: item }, action));
      continue;
    }
    if (typeof item !== 'object') continue;
    const action = normalizeAction(item.action || item.type || item.verb || item.name);
    if (!action) continue;
    out.push(makeStructuredClaim(item, action));
  }
  return out;
}

function targetsOverlap(a, b) {
  const ta = (a || []).map((t) => String(t).toLowerCase());
  const tb = (b || []).map((t) => String(t).toLowerCase());
  if (!ta.length || !tb.length) return true;
  return ta.some((x) => tb.some((y) => x.includes(y) || y.includes(x)));
}

function mergeClaims(structured, fromText) {
  const out = [...structured];
  for (const c of fromText) {
    if (c.umbrella) {
      out.push(c);
      continue;
    }
    const idx = out.findIndex((e) => !e.umbrella && e.action === c.action && targetsOverlap(e.targets, c.targets));
    if (idx < 0) {
      out.push(c);
      continue;
    }
    const e = out[idx];
    if (!(e.targets && e.targets.length) && c.targets && c.targets.length) e.targets = c.targets;
    if (e.amount == null && c.amount != null) e.amount = c.amount;
    if (!e.currency && c.currency) e.currency = c.currency;
    if (c.count && !e.count) e.count = c.count;
    if (c.needs === 'S4') e.needs = 'S4';
    if (!e.sentence || e.structured) e.sentence = c.sentence || e.sentence;
  }
  return out;
}

function readStructuredActions(src, reply) {
  const keys = ['actions', 'actionsDone', 'actions_done', 'structuredActions', 'structured_actions'];
  function from(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      if (Array.isArray(obj[k])) return obj[k];
    }
    return null;
  }
  const direct = from(src);
  if (direct) return direct;
  const parsed = parseMaybeJson(reply);
  if (Array.isArray(parsed)) return parsed;
  const nested = from(parsed);
  if (nested) return nested;
  return null;
}

function displayReply(reply) {
  if (reply == null || reply === '') return '';
  if (typeof reply === 'object' && !Array.isArray(reply)) {
    if (reply.text != null) return String(reply.text);
    if (reply.reply != null && typeof reply.reply !== 'object') return String(reply.reply);
    if (reply.message != null && typeof reply.message !== 'object') return String(reply.message);
    return '';
  }
  const s = String(reply);
  const parsed = parseMaybeJson(s);
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed)) return '';
    if (parsed.text != null) return String(parsed.text);
    if (parsed.reply != null && typeof parsed.reply !== 'object') return String(parsed.reply);
    if (parsed.message != null && typeof parsed.message !== 'object') return String(parsed.message);
  }
  return s;
}

function replyFromActions(actions) {
  const parts = (actions || []).map((a) => {
    if (a == null) return '';
    if (typeof a === 'string') return a;
    return [a.action || a.type || a.verb, a.status, a.target != null && typeof a.target !== 'object' ? a.target : ''].filter((v) => v != null && v !== '').join(' ');
  }).filter(Boolean);
  return parts.length ? parts.join('; ') : '';
}


function bestGrade(calls) {
  if (!calls.length) return 'S0';
  let g = calls[0]._grade;
  for (const c of calls.slice(1)) {
    if (RANK[c._grade] > RANK[g]) g = c._grade;
  }
  return g;
}

function why(calls, grade) {
  for (const c of calls) {
    if (c._grade === grade && c.note) return ` (${c.note})`;
  }
  return '';
}

function stableTarget(target) {
  if (target && typeof target === 'object') {
    const keys = Object.keys(target).sort();
    const o = {};
    for (const k of keys) o[k] = target[k];
    return JSON.stringify(o);
  }
  return JSON.stringify(target);
}

function groupLabel(c) {
  return targetOnly(c) || (c.id ? `id ${c.id}` : '(no target)');
}

function sameAmount(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

function partialFinding(claim, calls, ids) {
  const p = calls.find((c) => c._grade === 'P' && c._batch);
  const lead = claim.count ? `partial: claim says ${claim.count}, log shows ` : 'partial: ';
  return { claim, status: 'partial', grade: 'P', reason: lead + (p ? describeBatch(p._batch) : 'some items failed'), calls: ids };
}

// v1.4.0: which calls can back an implied claim. A shipment is a 'ship'
// call or any call whose tool or action names shipping; an email promise
// prefers email tools and falls back to any send call.
function callsFor(claim, calls) {
  if (claim.action === 'ship') {
    return calls.filter((c) => c.action === 'ship'
      || (!c.informational && SHIP_TOOL_RE.test(`${c.tool || ''} ${c.action || ''}`)))
      .map((c) => (c.action === 'ship' ? c : { ...c, action: 'ship' }));
  }
  if (claim.hint === 'email') {
    const same = calls.filter((c) => c.action === claim.action);
    const mail = same.filter((c) => EMAIL_TOOL_RE.test(`${c.tool || ''} ${c.channel || ''}`));
    const pick = mail.length ? mail : same.filter((c) => !CHAT_TOOL_RE.test(`${c.tool || ''} ${c.channel || ''}`));
    return pick.concat(calls.filter((c) => c.action !== claim.action));
  }
  return calls;
}

function checkClaim(claim, calls) {
  if (claim.umbrella) {
    if (!calls.length) return { claim, status: 'gap', grade: 'S0', reason: 'umbrella claim, but the log has no tool calls', calls: [] };
    let live = calls.filter((c) => !c.informational && !c.superseded);
    if (!live.length) return { claim, status: 'gap', grade: 'S0', reason: 'umbrella claim, but the log has only read-only lookups', calls: [] };
    // A failed attempt that a later call for the same action and target fixed is not a gap.
    const weak = live.filter((c) => RANK[c._grade] < 3 && !live.some((d) => d._i > c._i
      && d.action === c.action && groupLabel(d) === groupLabel(c) && RANK[d._grade] >= 3));
    if (weak.length) {
      const names = weak.map((c) => `${c.tool || '?'} (${c._grade}${c._grade === 'P' && c._batch ? `: ${describeBatch(c._batch)}` : ''})`).join(', ');
      const allPartial = weak.every((c) => c._grade === 'P');
      return { claim, status: allPartial ? 'partial' : 'gap', grade: bestGrade(weak), reason: `umbrella claim, but these calls are below S3: ${names}`, calls: weak.map((c) => c._i) };
    }
    return { claim, status: 'ok', grade: bestGrade(live), reason: 'every call in the log is S3 or better', calls: live.map((c) => c._i) };
  }
  if (claim.implied) {
    const pool = callsFor(claim, calls);
    if (claim.hint === 'email' && !pool.some((c) => c.action === claim.action) && calls.some((c) => c.action === claim.action)) {
      const chat = [...new Set(calls.filter((c) => c.action === claim.action).map((c) => c.tool || '?'))].join(', ');
      return { claim, status: 'gap', grade: 'S0', reason: `implied ${claim.implied}: no email send in the log, only chat sends (${chat})`, calls: [] };
    }
    const f = checkClaim({ ...claim, implied: null }, pool);
    f.claim = claim;
    f.reason = `implied ${claim.implied}: ${f.reason}`;
    return f;
  }
  const same = calls.filter((c) => c.action === claim.action);
  if (!same.length) return { claim, status: 'gap', grade: 'S0', reason: `no '${claim.action}' call in the log`, calls: [] };
  let matched = same;
  const named = Boolean(claim.targets && claim.targets.length);
  if (named) {
    matched = same.filter((c) => claim.targets.some((t) => targetMatches(t, c)));
    for (const c of same) {
      if (c.target_unknown && !matched.includes(c)) matched.push(c);
    }
    if (!matched.length) {
      const seen = [...new Set(same.map((c) => groupLabel(c)))].sort().join(', ');
      const from = claim.boundBy === 'replyTarget' ? ' (from replyTarget)' : '';
      return { claim, status: 'gap', grade: 'S0', reason: `wrong target: claim names ${claim.targets.join(', ')}${from}, log has '${claim.action}' for: ${seen}`, calls: [] };
    }
  }
  if (claim.amount != null) {
    const withAmt = matched.filter((c) => c.amount != null);
    if (withAmt.length) {
      const eq = withAmt.filter((c) => sameAmount(c.amount, claim.amount));
      if (!eq.length) {
        const amounts = [...new Set(withAmt.map((c) => Number(c.amount)))];
        const shown = amounts.sort((a, b) => a - b).map(String).join(', ');
        const cents = amounts.some((a) => sameAmount(a, claim.amount * 100)) ? ' (if your log stores cents, send amount_cents or amount_unit: "cents")' : '';
        return { claim, status: 'gap', grade: bestGrade(matched), reason: `amount mismatch: claim says ${claim.amount}, log shows ${shown}${cents}`, calls: matched.map((c) => c._i) };
      }
      matched = named ? eq.concat(matched.filter((c) => c.amount == null)) : eq;
    }
    if (claim.currency) {
      const withCur = matched.filter((c) => c.currency);
      if (withCur.length && !withCur.some((c) => c.currency === claim.currency)) {
        const shown = [...new Set(withCur.map((c) => c.currency))].sort().join(', ');
        return { claim, status: 'gap', grade: bestGrade(matched), reason: `currency mismatch: claim says ${claim.currency.toUpperCase()}, log shows ${shown.toUpperCase()}`, calls: matched.map((c) => c._i) };
      }
    }
  }
  const grade = bestGrade(matched);
  const ids = matched.map((c) => c._i);
  if (claim.count) {
    const good = new Set();
    let batchGood = 0;
    let sawPartial = false;
    for (const c of matched) {
      const isBatch = c._batch && c._batch.total > 1;
      if (isBatch) {
        if (c._grade === 'P') {
          sawPartial = true;
          if (c.id || c.object_id || DONE.has(String(c.status || '').toLowerCase())) batchGood += c._batch.succeeded;
        } else if (RANK[c._grade] >= RANK[claim.needs]) {
          batchGood += c._batch.succeeded;
        }
        continue;
      }
      if (RANK[c._grade] >= RANK[claim.needs]) good.add(stableTarget(targetSource(c)));
    }
    const total = good.size + batchGood;
    if (total < claim.count) {
      if (sawPartial) return partialFinding(claim, matched, ids);
      return { claim, status: 'gap', grade, reason: `partial batch: ${total} of ${claim.count} reached ${claim.needs}`, calls: ids };
    }
    return { claim, status: 'ok', grade, reason: `${total} of ${claim.count} reached ${claim.needs}`, calls: ids };
  }
  if (!named) {
    // A commenter on r/n8n: refund for order 184 succeeds, refund for
    // order 185 fails, and the 185 customer is told "Your refund has been
    // processed". A claim that names no order, recipient or amount cannot
    // borrow the success of a different target.
    const groups = new Map();
    for (const c of matched) {
      const k = groupLabel(c);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    if (groups.size > 1) {
      const rows = [...groups.entries()].map(([k, cs]) => [k, bestGrade(cs)]);
      const weak = rows.filter(([, g]) => RANK[g] < RANK[claim.needs]);
      if (weak.length) {
        const list = rows.map(([k, g]) => `${k} ${g}`).join(', ');
        const worst = weak.reduce((w, [, g]) => (RANK[g] < RANK[w] ? g : w), weak[0][1]);
        return { claim, status: 'gap', grade: worst, reason: `ambiguous target: the claim names no order, recipient or amount, and the log has '${claim.action}' for ${groups.size} targets (${list}). Name the target in the reply or send replyTarget`, calls: ids };
      }
    }
  }
  if (grade === 'P') return partialFinding(claim, matched, ids);
  if (RANK[grade] < RANK[claim.needs]) {
    return { claim, status: 'gap', grade, reason: `wording needs ${claim.needs}, best evidence is ${grade}` + why(matched, grade), calls: ids };
  }
  return { claim, status: 'ok', grade, reason: `supported at ${grade}`, calls: ids };
}

function findDuplicates(calls) {
  const groups = new Map();
  for (const c of calls) {
    if (RANK[c._grade] < 2 || c.repeat_ok || c.informational) continue;
    const key = JSON.stringify([c.tool, c.action, stableTarget(targetSource(c))]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const dupes = [];
  for (const [key, group] of groups) {
    const keys = new Set(group.map((c) => c.idempotency_key));
    if (group.length > 1 && (keys.has(undefined) || keys.has(null) || keys.size > 1)) {
      const [tool, action, target] = JSON.parse(key);
      dupes.push({ tool, action, target: JSON.parse(target), calls: group.map((c) => c._i) });
    }
  }
  // A timeout has an unknown outcome. Retrying it without an idempotency key
  // can run the action twice (two refunds, two emails).
  for (const c of calls) {
    if (c._grade !== 'S1' || c.informational || c.repeat_ok) continue;
    const retry = calls.find((d) => d._i > c._i && RANK[d._grade] >= 2 && d.tool === c.tool && d.action === c.action
      && stableTarget(targetSource(d)) === stableTarget(targetSource(c))
      && !(c.idempotency_key && c.idempotency_key === d.idempotency_key));
    if (retry) {
      dupes.push({ tool: c.tool, action: c.action, target: c.target, calls: [c._i, retry._i], kind: 'retry_after_unknown' });
    }
  }
  return dupes;
}

function findingToDict(f) {
  return {
    claim: { ...f.claim },
    status: f.status,
    grade: f.grade,
    reason: f.reason,
    calls: f.calls,
  };
}

function toText(findings, duplicates, stopShip, disclosures) {
  const lines = [];
  for (const f of findings) {
    const mark = f.status === 'gap' ? 'GAP' : (f.status === 'partial' ? 'PART' : 'ok ');
    const verb = String(f.claim.verb).padEnd(11);
    const grade = String(f.grade).padEnd(2);
    lines.push(`[${mark}] ${verb} ${grade}  ${f.reason}`);
    lines.push(`       "${f.claim.sentence}"`);
  }
  for (const d of duplicates) {
    if (d.kind === 'retry_after_unknown') {
      lines.push(`[DUP] ${d.tool} ${d.action} ${flatText(d.target)} retried after an unknown result without one idempotency key, so it may have run twice (entries ${d.calls})`);
    } else {
      lines.push(`[DUP] ${d.tool} ${d.action} ${d.target} logged ${d.calls.length} times without one idempotency key (entries ${d.calls})`);
    }
  }
  for (const d of disclosures || []) {
    if (d.kind === 'conditional') {
      lines.push(`[NOTE] reply promises ${d.action || 'an action'} (${d.verb}) only on a condition, not counted as a claim: "${d.sentence}"`);
      continue;
    }
    lines.push(`[NOTE] reply says ${d.action || 'an action'} is ${d.kind === 'pending' ? `still ${d.verb}` : 'not done'}, not counted as a claim: "${d.sentence}"`);
  }
  const gaps = findings.filter((f) => f.status !== 'ok');
  const rate = findings.length ? gaps.length / findings.length : 0;
  lines.push('');
  lines.push(`${gaps.length} gap(s) in ${findings.length} claim(s), gap rate ${Math.round(rate * 100)}%` +
    (stopShip ? '  STOP-SHIP: a payment or delete claim is unsupported' : ''));
  return lines.join('\n');
}

function toTargetList(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x).toLowerCase().trim().replace(/^#/, '')).filter(Boolean);
}

/**
 * opts.partialRules: see DEFAULT_PARTIAL_RULES.
 * opts.replyTarget: the order id, email or name this reply is about. Claims
 * that name no target are bound to it.
 */
function diff(message, log, markers, actions, opts) {
  const o = opts || {};
  const calls = loadLog(log, markers, o.partialRules);
  const replyTargets = toTargetList(o.replyTarget);
  const claims = mergeClaims(structuredClaims(actions), extractClaims(message));
  if (replyTargets.length) {
    for (const c of claims) {
      if (!c.umbrella && !(c.targets && c.targets.length)) {
        c.targets = replyTargets;
        c.boundBy = 'replyTarget';
      }
    }
  }
  const findings = claims.map((c) => checkClaim(c, calls));
  const duplicates = findDuplicates(calls);
  const disclosures = extractDisclosures(message);
  const gaps = findings.filter((f) => f.status !== 'ok');
  const partials = findings.filter((f) => f.status === 'partial');
  const stopShip = gaps.some((f) => f.claim.action === 'pay' || f.claim.action === 'delete');
  const gapRate = findings.length ? gaps.length / findings.length : 0;
  return {
    findings,
    duplicates,
    disclosures,
    calls,
    gaps,
    partials,
    stop_ship: stopShip,
    gap_rate: gapRate,
    claims: findings.length,
    report: toText(findings, duplicates, stopShip, disclosures),
  };
}

function dig(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstJson(run) {
  const data = (run && run.data) || {};
  for (const key of ['main', 'ai_tool']) {
    const branches = data[key] || [];
    for (const branch of branches) {
      for (const item of branch || []) {
        if (item && typeof item === 'object' && item.json && typeof item.json === 'object') return item.json;
      }
    }
  }
  return {};
}

function readExecution(execution) {
  if (typeof execution !== 'string') return execution;
  const parsed = parseMaybeJson(execution);
  if (parsed === undefined || typeof parsed !== 'object') {
    throw new Error('Could not read "execution": it is not valid JSON. Send the body of GET /api/v1/executions/<id>?includeData=true.');
  }
  return parsed;
}

function toLog(execution, nodeMap, markers) {
  const rules = isNormalizedMarkers(markers) ? markers : normalizeFailureMarkers(markers);
  execution = readExecution(execution);
  const runData = dig(execution, 'data.resultData.runData') || {};
  const calls = [];
  const nodes = (nodeMap && nodeMap.nodes) || {};
  for (const [node, spec] of Object.entries(nodes)) {
    const runs = Array.isArray(runData[node]) ? runData[node] : [];
    for (const run of runs) {
      if (!run || typeof run !== 'object') continue;
      const out = firstJson(run);
      const entry = { tool: spec.tool || node, action: spec.action };
      const target = spec.target ? dig(out, spec.target) : spec.target_value;
      if (target !== undefined && target !== null) entry.target = target;
      for (const field of ['id', 'status', 'http_status', 'amount', 'idempotency_key']) {
        const path = spec[field];
        const val = path ? dig(out, path) : undefined;
        if (val !== undefined && val !== null) entry[field] = val;
      }
      if (run.error || run.executionStatus === 'error') {
        entry.error = (run.error && run.error.message) || 'node error';
      } else if (callReportsFailure(out, rules)) {
        entry.status = 'error';
        entry.note = 'response body reported failure';
        entry.body = out;
      } else if (entry.status == null) {
        entry.status = 'done';
      }
      calls.push(entry);
    }
  }
  return calls;
}

function replyText(execution, nodeMap) {
  const spec = (nodeMap && nodeMap.reply) || {};
  const runs = (dig(execution, 'data.resultData.runData') || {})[spec.node || ''] || [];
  if (!runs.length) return '';
  const val = dig(firstJson(runs[runs.length - 1]), spec.field || 'output');
  return val == null ? '' : String(val);
}

function parseMaybeJson(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'object') return value;
  const s = String(value).trim();
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function hasKey(obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k);
}

function checkPayload(input, defaultNodeMap, markers, partialRules) {
  let src = input;
  if (typeof src === 'string') {
    src = parseMaybeJson(src);
    if (src === undefined) throw new Error('The request body is not valid JSON. Send an object with "reply" and "calls".');
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    throw new Error('The request body must be a JSON object with "reply" and "calls" (or "execution" plus "nodeMap").');
  }
  const rules = normalizeFailureMarkers(src.failureMarkers ?? src.failure_markers ?? markers);
  const pRules = normalizePartialRules(src.partialRules ?? src.partial_rules ?? partialRules);
  const rawReply = src.reply != null ? src.reply : (src.message != null ? src.message : '');
  let execution = src.execution || src.executionJson;
  const nodeMap = parseMaybeJson(src.nodeMap || src.node_map) || defaultNodeMap;
  let callsIn;
  for (const k of ['calls', 'toolLog', 'tool_log']) {
    if (hasKey(src, k) && src[k] != null) { callsIn = src[k]; break; }
  }
  if (typeof callsIn === 'string' && !callsIn.trim()) callsIn = [];
  let reply = rawReply;
  if (execution) {
    execution = readExecution(execution);
    const mapped = toLog(execution, nodeMap || { nodes: {} }, rules);
    if (callsIn == null) callsIn = mapped;
    if ((reply == null || reply === '') && nodeMap) reply = replyText(execution, nodeMap);
  }
  const actions = readStructuredActions(src, reply);
  let text = typeof reply === 'number' ? String(reply) : displayReply(reply);
  if (!String(text).trim()) text = replyFromActions(actions);
  if (!String(text).trim()) {
    throw new Error('Missing "reply" (and no reply could be read from the execution plus node map).');
  }
  if (callsIn == null) {
    throw new Error('Missing "calls" (or pass "execution" plus a node map). Send "calls": [] if the agent made no tool calls.');
  }
  const replyTarget = src.replyTarget ?? src.reply_target ?? src.recipient;
  const report = diff(text, callsIn, rules, actions, { partialRules: pRules, replyTarget });
  reply = normalizeText(text);
  let verdict = 'pass';
  if (report.stop_ship) verdict = 'stop_ship';
  else if (report.gaps.length) verdict = 'review';
  return {
    version: VERSION,
    reply,
    calls: report.calls.map((c) => {
      const { _grade, _i, _batch, ...rest } = c;
      const out = { ...rest, grade: _grade };
      if (_batch && (_batch.failed || _batch.pending)) out.batch = { ..._batch };
      return out;
    }),
    findings: report.findings.map(findingToDict),
    duplicates: report.duplicates,
    disclosures: report.disclosures,
    claims: report.claims,
    gaps: report.gaps.length,
    partials: report.partials.length,
    gapRate: Math.round(report.gap_rate * 1000) / 1000,
    stopShip: report.stop_ship,
    verdict,
    report: report.report,
  };
}

module.exports = {
  VERSION, RANK, gradeCall, loadLog, extractClaims, checkClaim, findDuplicates, diff,
  dig, firstJson, toLog, replyText, parseMaybeJson, checkPayload, toText,
  DEFAULT_FAILURE_MARKERS, normalizeFailureMarkers, callReportsFailure,
  structuredClaims, mergeClaims, readStructuredActions, displayReply, normalizeAction,
  DEFAULT_PARTIAL_RULES, normalizePartialRules, batchOutcome, extractDisclosures, targetMatches,
  normalizeCall, parseAmount,
};
