#!/usr/bin/env node
/*
 * eosl-mcp — MCP server for EOSL.ai hardware end-of-life lookups (stdio transport).
 *
 * This is the SELF-HOSTABLE twin of the hosted endpoint at https://eosl.ai/mcp (Streamable HTTP,
 * no auth, listed in the official MCP registry as `ai.eosl/eosl`). Same five tools, same matching
 * rules, reading the same public data (https://eosl.ai/data/lookup.json, CC BY 4.0). If you just
 * want the tools, the hosted endpoint needs no install at all:
 *
 *   claude mcp add --transport http eosl https://eosl.ai/mcp
 *
 * Run this version when you want a local stdio server instead:
 *
 *   npx eosl-mcp            (or)  node server.js
 *
 * Matching is exact, then punctuation-insensitive, then vendor-gated Fortinet short-SKU aliases
 * (FG-60E -> FortiGate-60E) — never fuzzy. An unknown part returns found:false rather than a guess,
 * and every date carries the URL of the manufacturer's own end-of-life bulletin, because a lifecycle
 * date without its source is exactly what this project exists to replace.
 *
 * Zero dependencies. Node >= 18 (global fetch). Apache-2.0; the data is CC BY 4.0.
 */
'use strict';

const readline = require('node:readline');

const SITE = 'https://eosl.ai';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_PART = 100;
const MAX_QUERY = 120;
const MAX_BULK = 200;
const DISCLAIMER = 'Confirm critical dates against the linked vendor bulletin (sourceUrl) before acting.';
const VERSION = '1.0.0';

// Fortinet publishes two names for one device (FG-100F vs FortiGate-100F). Aliases are vendor-gated:
// applied when the caller omits the vendor or names Fortinet, off when they name anyone else.
const FORTINET_PREFIX = {
  FG: 'FORTIGATE', FAP: 'FORTIAP', FSW: 'FORTISWITCH', FS: 'FORTISWITCH',
  FAZ: 'FORTIANALYZER', FMG: 'FORTIMANAGER', FWB: 'FORTIWEB', FML: 'FORTIMAIL', FAD: 'FORTIADC',
};
const VENDOR_SLUG_OVERRIDES = { 'palo alto networks': 'palo-alto' };
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const vendorSlug = (name) => VENDOR_SLUG_OVERRIDES[name.toLowerCase()] || slugify(name);

// ---- data ---------------------------------------------------------------------------------------
let cache = { data: null, at: 0 };
const TTL_MS = 15 * 60 * 1000;

async function getData() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  const resp = await fetch(`${SITE}/data/lookup.json`, { headers: { 'user-agent': `eosl-mcp/${VERSION}` } });
  if (!resp.ok) throw new Error(`lookup.json unavailable (HTTP ${resp.status})`);
  const raw = await resp.json();
  const exact = new Map(), looseIdx = new Map();      // first writer wins
  for (const rec of raw.skus) {
    const pid = (rec.p || '').trim().toUpperCase();
    if (!pid) continue;
    if (!exact.has(pid)) exact.set(pid, rec);
    const lk = loose(pid);
    if (!looseIdx.has(lk)) looseIdx.set(lk, rec);
  }
  const famHay = raw.families.map((f) => `${f.v} ${f.n} ${f.s}`.toLowerCase());
  cache = { data: { skus: raw.skus, families: raw.families, famHay, exact, looseIdx }, at: Date.now() };
  return cache.data;
}

// ---- matching (deterministic, never fuzzy) ------------------------------------------------------
const loose = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function candidateLooseKeys(part, vendor) {
  const keys = [], seen = new Set();
  const add = (raw) => { const k = loose(raw); if (k && !seen.has(k)) { seen.add(k); keys.push(k); } };
  add(part);
  if (!vendor || /fortinet/i.test(vendor)) {
    const lp = loose(part);
    for (const [ab, full] of Object.entries(FORTINET_PREFIX)) {
      if (lp.startsWith(ab) && lp.length > ab.length && !lp.startsWith(full)) add(full + lp.slice(ab.length));
    }
  }
  return keys;
}

function matchPart(part, vendor, data) {
  const u = part.trim().toUpperCase();
  let rec = data.exact.get(u) || null, via = 'exact';
  if (!rec) {
    for (const k of candidateLooseKeys(part, vendor)) {
      rec = data.looseIdx.get(k) || null;
      if (rec) { via = k === loose(part) ? 'loose' : 'vendor-alias'; break; }
    }
  }
  // A caller-named vendor is a constraint, never a suggestion — another vendor's dates are worse
  // than no answer.
  if (rec && vendor && loose(vendor)) {
    const lv = loose(vendor), rv = loose(rec.v);
    if (!rv.includes(lv) && !lv.includes(rv)) return { rec: null, via: null };
  }
  return { rec, via: rec ? via : null };
}

// ---- status (from dataset fields only — no invented dates) --------------------------------------
function deriveStatus(rec) {
  if (rec.a) return 'active — no EOL announced';
  if (!rec.eol) return 'unknown — no EOSL date on record, see source';
  const m = /^(\d{4})-(\d{2})/.exec(rec.eol);
  if (!m) return 'unknown — see source';
  const now = new Date();
  const diff = (+m[1] * 12 + (+m[2] - 1)) - (now.getUTCFullYear() * 12 + now.getUTCMonth());
  if (diff < 0) return 'past end of service life';
  if (diff <= 12) return 'ending within 12 months';
  return 'supported — EOSL announced';
}

const statusBucket = (status) =>
  status.startsWith('active') ? 'active' :
  status.startsWith('past') ? 'past' :
  status.startsWith('ending') ? 'endingSoon' : 'supported';

function skuResult(rec, via, queried) {
  const out = {
    found: true, part: rec.p, vendor: rec.v, family: rec.f,
    status: deriveStatus(rec),
    endOfSale: rec.eos || null, endOfServiceLife: rec.eol || null,
    exposureScore: rec.xs, exposureBand: rec.xb,
    sourceUrl: rec.src, pageUrl: `${SITE}/system/${rec.s}/`,
    disclaimer: DISCLAIMER,
  };
  if (via !== 'exact') out.matchedVia = via;
  if (queried && queried.toUpperCase() !== rec.p.toUpperCase()) out.queried = queried;
  return out;
}

const notFound = (part) => ({
  found: false, queried: part,
  searchUrl: `${SITE}/?q=${encodeURIComponent(part)}`,
  note: 'No source-backed record for this part number. EOSL.ai never guesses dates — try search_models or the searchUrl.',
});

const toolText = (summary, obj) => ({ content: [{ type: 'text', text: `${summary}\n${JSON.stringify(obj, null, 2)}` }] });
const toolError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// ---- tools (identical to the hosted endpoint) ---------------------------------------------------
const TOOLS = [
  { name: 'lookup_part',
    description: 'Look up one hardware part number in the EOSL.ai database. Returns support status, End-of-Sale and End-of-Service-Life dates, support runway score, and the primary vendor bulletin URL backing the dates. Matching is exact, then punctuation-insensitive, then Fortinet short-SKU aliases (FG-60E -> FortiGate-60E). Returns found:false rather than guessing.',
    inputSchema: { type: 'object', properties: {
      part_number: { type: 'string', description: 'Vendor part number / SKU, e.g. "WS-C3850-48P-S" or "FG-100F".' },
      vendor: { type: 'string', description: 'Optional vendor hint, e.g. "Cisco". Restricts the match to that vendor.' },
    }, required: ['part_number'] } },
  { name: 'bulk_check',
    description: 'Check up to 200 part numbers in one call. Returns a per-part row (status, EOSL date, source URL, page URL) plus summary counts: past, endingSoon, supported, active, notFound.',
    inputSchema: { type: 'object', properties: {
      part_numbers: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200, description: 'Part numbers to check (deduplicated; max 200).' },
    }, required: ['part_numbers'] } },
  { name: 'search_models',
    description: 'Search tracked product families by vendor, product line, or series name (case-insensitive substring, e.g. "nexus 9300"). Returns up to 10 families with status, EOSL window, and page URL. Use get_family with a returned slug for the full record.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 120, description: 'Search text, 1-120 characters.' },
    }, required: ['query'] } },
  { name: 'get_family',
    description: 'Fetch the full source-backed record for one product family by slug (from search_models or lookup_part pageUrl): lifecycle dates per SKU group, every part number, support runway score factors, and the vendor bulletin URLs.',
    inputSchema: { type: 'object', properties: {
      slug: { type: 'string', description: 'Family slug, e.g. "cisco-catalyst-3850".' },
    }, required: ['slug'] } },
  { name: 'list_vendors',
    description: 'List all vendors tracked by EOSL.ai with family counts and vendor page URLs.',
    inputSchema: { type: 'object', properties: {} } },
];

async function callTool(name, args) {
  args = args && typeof args === 'object' ? args : {};

  if (name === 'lookup_part') {
    const part = typeof args.part_number === 'string' ? args.part_number.trim() : '';
    if (!part) return toolError('lookup_part requires a non-empty string "part_number".');
    if (part.length > MAX_PART) return toolError(`part_number too long (max ${MAX_PART} characters).`);
    const vendor = typeof args.vendor === 'string' ? args.vendor.trim().slice(0, MAX_PART) : '';
    const data = await getData();
    const { rec, via } = matchPart(part, vendor, data);
    if (!rec) return toolText(`${part}: not found in the EOSL.ai database.`, notFound(part));
    const r = skuResult(rec, via, part);
    return toolText(`${r.part} (${r.vendor} ${r.family}): ${r.status}. EOSL ${r.endOfServiceLife || 'n/a'} — vendor bulletin: ${r.sourceUrl}`, r);
  }

  if (name === 'bulk_check') {
    if (!Array.isArray(args.part_numbers)) return toolError('bulk_check requires "part_numbers" as an array of strings.');
    const seen = new Set(), parts = [];
    for (const p of args.part_numbers) {
      if (typeof p !== 'string') continue;
      const t = p.trim().slice(0, MAX_PART);
      const k = t.toUpperCase();
      if (t && !seen.has(k)) { seen.add(k); parts.push(t); }
    }
    if (!parts.length) return toolError('bulk_check: no valid part numbers supplied.');
    if (parts.length > MAX_BULK) return toolError(`bulk_check: ${parts.length} unique part numbers exceeds the ${MAX_BULK} limit — split into batches.`);
    const data = await getData();
    const summary = { past: 0, endingSoon: 0, supported: 0, active: 0, notFound: 0 };
    const rows = parts.map((part) => {
      const { rec } = matchPart(part, '', data);
      if (!rec) { summary.notFound++; return { part, found: false }; }
      const status = deriveStatus(rec);
      const bucket = statusBucket(status);
      if (bucket in summary) summary[bucket]++;
      return {
        part, found: true, matched: rec.p, vendor: rec.v, family: rec.f, status,
        endOfServiceLife: rec.eol || null, sourceUrl: rec.src, pageUrl: `${SITE}/system/${rec.s}/`,
      };
    });
    const result = { checked: parts.length, summary, results: rows, disclaimer: DISCLAIMER };
    return toolText(`Checked ${parts.length} part numbers: ${summary.past} past EOSL, ${summary.endingSoon} ending within 12 months, ${summary.supported} supported, ${summary.active} active, ${summary.notFound} not found.`, result);
  }

  if (name === 'search_models') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return toolError('search_models requires a non-empty string "query".');
    if (query.length > MAX_QUERY) return toolError(`query too long (max ${MAX_QUERY} characters).`);
    const data = await getData();
    const q = query.toLowerCase();
    const hits = data.families.filter((f, i) => data.famHay[i].includes(q));
    const results = hits.slice(0, 10).map((f) => ({
      name: f.n, vendor: f.v, slug: f.s, status: deriveStatus(f),
      endOfSale: f.eos || null, endOfServiceLife: f.eol || null,
      pageUrl: `${SITE}/system/${f.s}/`,
    }));
    return toolText(`"${query}": ${hits.length} famil${hits.length === 1 ? 'y' : 'ies'} matched${hits.length > 10 ? ' (showing 10)' : ''}.`,
      { query, totalMatches: hits.length, results });
  }

  if (name === 'get_family') {
    const slug = typeof args.slug === 'string' ? args.slug.trim().toLowerCase() : '';
    if (!slug || !/^[a-z0-9-]{1,120}$/.test(slug)) return toolError('get_family requires "slug": lowercase letters, digits, and hyphens (e.g. "cisco-catalyst-3850").');
    const resp = await fetch(`${SITE}/api/v1/family/${slug}.json`, { headers: { 'user-agent': `eosl-mcp/${VERSION}` } });
    if (!resp.ok) return toolText(`${slug}: no family record.`, { found: false, slug, hint: 'Unknown family slug — use search_models to find the right slug.' });
    const fam = await resp.json();
    return toolText(`${fam.vendor} ${fam.series}: ${fam.skuCount || 0} SKUs, status "${fam.status && fam.status.label}". Full source-backed record follows.`, fam);
  }

  if (name === 'list_vendors') {
    const data = await getData();
    const counts = new Map();
    for (const f of data.families) counts.set(f.v, (counts.get(f.v) || 0) + 1);
    const vendors = [...counts.entries()]
      .map(([name2, families]) => ({ name: name2, families, pageUrl: `${SITE}/vendor/${vendorSlug(name2)}/` }))
      .sort((a, b) => b.families - a.families);
    return toolText(`${vendors.length} vendors tracked, ${data.families.length} product families.`, { vendors });
  }

  return toolError(`Unknown tool "${name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`);
}

// ---- JSON-RPC over stdio (newline-delimited, per the MCP stdio transport) -----------------------
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 object.');
  }
  const { method, id, params } = msg;
  if (typeof method !== 'string') return id === undefined ? null : rpcError(id, -32600, 'Invalid Request: missing method.');
  if (id === undefined) return null;                    // notification — no response
  try {
    if (method === 'initialize') {
      const requested = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'eosl', title: 'EOSL.ai — Hardware End-of-Life Database', version: VERSION },
        instructions: 'Look up end-of-life status for enterprise datacenter hardware (Cisco, Dell, HPE, Fortinet, IBM, Juniper, and more) by part number or product family. Every date is backed by a linked vendor bulletin — nothing is estimated, and unknown parts return found:false. Confirm critical dates at the sourceUrl before making support or purchasing decisions.',
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name;
      if (typeof name !== 'string') return rpcError(id, -32602, 'tools/call requires params.name.');
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      return rpcResult(id, await callTool(name, params.arguments));
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    if (method === 'tools/call') return rpcResult(id, toolError('EOSL.ai dataset temporarily unavailable — retry shortly.'));
    return rpcError(id, -32603, 'Internal error.');
  }
}

function serve() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { process.stdout.write(JSON.stringify(rpcError(null, -32700, 'Parse error.')) + '\n'); return; }
    const resp = await handleMessage(msg);
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  });
  // Keep firmly quiet on stdout except JSON-RPC — stdio clients treat stray output as protocol noise.
  process.on('uncaughtException', (e) => { process.stderr.write(`eosl-mcp: ${e.message}\n`); });
}

// ---- selftest -----------------------------------------------------------------------------------
async function selftest() {
  let fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  ok(init.result && init.result.serverInfo.name === 'eosl', 'initialize returns the server card');
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  ok(list.result && list.result.tools.length === 5, 'tools/list returns exactly 5 tools');
  const bad = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } });
  ok(bad.error && bad.error.code === -32602, 'CONTROL: an unknown tool is a JSON-RPC error, not a crash');
  const note = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  ok(note === null, 'CONTROL: a notification gets no response');

  // Network-dependent: exercised against the live public data this server actually reads.
  try {
    const hit = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lookup_part', arguments: { part_number: 'WS-C3850-48P-S' } } });
    const text = hit.result.content[0].text;
    ok(/past end of service life/.test(text) && /cisco\.com/.test(text), 'lookup_part resolves a known part with its vendor bulletin');
    const miss = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lookup_part', arguments: { part_number: 'NOT-A-REAL-PART-999' } } });
    ok(/found": false/.test(miss.result.content[0].text), 'CONTROL: an invented part returns found:false, never a guess');
  } catch (e) {
    console.log(`  SKIP  network checks (${e.message}) — introspection checks above are the offline core`);
  }
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nall selftests pass');
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else serve();
