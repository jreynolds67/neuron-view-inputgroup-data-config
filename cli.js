#!/usr/bin/env node
// cli.js — Bulk TSL config for EVS Neuron View input groups.
//
// The Neuron View has 36 input groups. Each group carries a `bindings` array; the TSL
// tally wiring for a group lives in the bindings whose `input` is a "tsl::..." string.
// Configuring all 36 by hand in the web GUI is tedious, so this replicates ONE group's
// tally wiring onto the others, offsetting the TSL display index per group.
//
// A TSL binding input string is "tsl::<screen>::<display>". In TSL V5.0 terms:
//   screen index  -> stays the same across groups
//   display index -> increments per group (this is the per-group tally address)
// The `output` side of the binding (e.g. protocol::0::text) encodes the protocol slot and
// the suboption (text / left tally / right tally); we copy those verbatim.
//
// USAGE
//   node cli.js dump  --ip <board> [--group <n>]      inspect real bindings (start here)
//   node cli.js copy  --ip <board> [options]          replicate tally wiring
//
// copy options:
//   --ip <addr>          board IP/host                        (required)
//   --source <n>         source group number         (default 1)
//   --targets <list>     e.g. 2-36 or 2,3,10-14      (default: all groups except source)
//   --apply              actually write; without it, dry-run prints the plan only
//   --scheme https|http  (default https)             also honours BOARD_SCHEME env
//   --port <n>           (default 443/80)            also honours BOARD_PORT env
//
// TLS: boards ship self-signed certs. We use a scoped undici Agent that accepts them
// without weakening TLS globally, matching the working board client.

import { Agent } from 'undici';

// ---------- arg parsing ----------
function parseArgs(argv) {
  const cmd = argv[2];
  const opts = { _: [] };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true; // flag
      else { opts[key] = next; i++; }
    } else opts._.push(a);
  }
  return { cmd, opts };
}

// ---------- board client (scoped self-signed TLS) ----------
const SCHEME = (process.env.BOARD_SCHEME || 'https').toLowerCase();
const PORT = process.env.BOARD_PORT || (SCHEME === 'https' ? '443' : '80');
const REJECT = String(process.env.BOARD_TLS_REJECT_UNAUTHORIZED || 'false') === 'true';

function makeClient(scheme, port) {
  const agent = scheme === 'https' ? new Agent({ connect: { rejectUnauthorized: REJECT } }) : undefined;
  const suffix = ((scheme === 'https' && String(port) === '443') || (scheme === 'http' && String(port) === '80')) ? '' : `:${port}`;
  const base = (ip) => `${scheme}://${ip}${suffix}/api/v1`;
  return async function boardFetch(ip, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const url = `${base(ip)}${path}`;
    try {
      const res = await fetch(url, {
        ...options,
        dispatcher: agent,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      const text = await res.text();
      let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) {
        const err = new Error(`${options.method || 'GET'} ${path} -> HTTP ${res.status}${body ? ': ' + JSON.stringify(body).slice(0, 200) : ''}`);
        err.status = res.status; throw err;
      }
      return body;
    } catch (e) {
      if (e.status === undefined) throw new Error(`connection to ${ip} failed (${e.cause?.code || e.code || e.name})`);
      throw e;
    } finally { clearTimeout(timer); }
  };
}

// ---------- TSL logic ----------
// TSL input strings are "tsl::<screen>::<display>::<suboption>", where suboption is
// text / lefttally / righttally. (The API spec only shows the 3-part form, but real
// firmware uses this 4-part form.) We also tolerate a 3-part form with no suboption.
const TSL_RE = /^tsl::(\d+)::(\d+)(?:::([a-z]+))?$/i;
const isTsl = (b) => typeof b?.input === 'string' && TSL_RE.test(b.input);
function parseTsl(input) {
  const m = String(input).match(TSL_RE);
  return m ? { screen: +m[1], display: +m[2], sub: m[3] || null } : null;
}
const fmtTsl = (s, d, sub) => sub ? `tsl::${s}::${d}::${sub}` : `tsl::${s}::${d}`;

// operator number carried in the group name ("Input 12", "12 - CAM"...). First integer.
function groupNumber(name) { const m = String(name ?? '').match(/\d+/); return m ? +m[0] : null; }

// number -> sorted, deduped list. "2-36", "2,3,10-14", or a mix.
function parseTargets(spec) {
  const out = new Set();
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) { for (let n = +range[1]; n <= +range[2]; n++) out.add(n); }
    else if (/^\d+$/.test(part)) out.add(+part);
    else throw new Error(`bad --targets segment: "${part}"`);
  }
  return [...out].sort((a, b) => a - b);
}

// Build target bindings: keep the target's non-TSL bindings, replace TSL bindings with the
// source's TSL bindings offset by (targetNum - sourceNum) on the DISPLAY index only.
function planBindings(sourceGroup, targetGroup, sourceNum, targetNum) {
  const offset = targetNum - sourceNum;
  const srcTsl = (sourceGroup.bindings || []).filter(isTsl);
  const tgtNonTsl = (targetGroup.bindings || []).filter((b) => !isTsl(b));
  const newTsl = srcTsl.map((b) => {
    const p = parseTsl(b.input);
    return { ...b, input: fmtTsl(p.screen, p.display + offset, p.sub) };
  });
  const diffs = srcTsl.map((b, i) => ({ output: b.output, from: b.input, to: newTsl[i].input }));
  return { bindings: [...tgtNonTsl, ...newTsl], diffs, offset, keptNonTsl: tgtNonTsl.length };
}

// GroupChange body (api.yml): only writable fields; preserve target's own streams + name.
function toGroupChange(target, bindings) {
  return {
    audioUuid: target.audioUuid ?? '',
    bindings,
    dataUuid: target.dataUuid ?? '',
    name: target.name ?? '',
    videoUuid: target.videoUuid ?? '',
  };
}

// ---------- commands ----------
async function loadGroups(boardFetch, ip) {
  const groups = await boardFetch(ip, '/inputs/groups');
  if (!Array.isArray(groups)) throw new Error('board did not return a group array');
  return groups.map((g, index) => ({ ...g, index, num: groupNumber(g.name) ?? index + 1 }));
}

function findByNum(groups, num) {
  return groups.find((g) => g.num === num);
}

async function cmdDump(boardFetch, opts) {
  const ip = requireIp(opts);
  const groups = await loadGroups(boardFetch, ip);
  console.log(`\n${groups.length} input groups on ${ip}:\n`);
  const want = opts.group ? [Number(opts.group)] : groups.map((g) => g.num);
  for (const num of want) {
    const g = findByNum(groups, num);
    if (!g) { console.log(`  group ${num}: NOT FOUND`); continue; }
    const tsl = (g.bindings || []).filter(isTsl);
    const other = (g.bindings || []).filter((b) => !isTsl(b));
    console.log(`── group #${g.num}  "${g.name}"  (uuid ${g.uuid})`);
    console.log(`   video=${g.videoUuid || '-'}  audio=${g.audioUuid || '-'}  data=${g.dataUuid || '-'}`);
    if (!g.bindings || g.bindings.length === 0) { console.log('   (no bindings)\n'); continue; }
    console.log(`   TSL bindings (${tsl.length}):`);
    for (const b of tsl) {
      const p = parseTsl(b.input);
      const sub = p.sub ? `, ${p.sub}` : '';
      console.log(`     input=${b.input}  (screen ${p.screen}, display ${p.display}${sub})   ->  output=${b.output}`);
    }
    if (other.length) {
      console.log(`   other bindings (${other.length}):`);
      for (const b of other) console.log(`     input=${b.input}  ->  output=${b.output}`);
    }
    // Raw JSON of the first binding so we can confirm every field name exactly.
    if (g.bindings[0]) console.log(`   raw[0]: ${JSON.stringify(g.bindings[0])}`);
    console.log('');
  }
}

async function cmdCopy(boardFetch, opts) {
  const ip = requireIp(opts);
  const sourceNum = opts.source ? Number(opts.source) : 1;
  const apply = opts.apply === true;

  const groups = await loadGroups(boardFetch, ip);
  const source = findByNum(groups, sourceNum);
  if (!source) throw new Error(`source group #${sourceNum} not found`);

  const srcTslCount = (source.bindings || []).filter(isTsl).length;
  if (srcTslCount === 0) throw new Error(`source group #${sourceNum} has no TSL bindings to copy`);

  const targetNums = opts.targets
    ? parseTargets(opts.targets).filter((n) => n !== sourceNum)
    : groups.map((g) => g.num).filter((n) => n !== sourceNum);

  console.log(`\nSource: #${source.num} "${source.name}" — ${srcTslCount} TSL binding(s)`);
  console.log(`Mode:   ${apply ? 'APPLY (writing to board)' : 'DRY RUN (no writes)'}`);
  console.log(`Targets: ${targetNums.join(', ')}\n`);

  const plans = [];
  const seen = new Map(); // "screen::display" -> [groupNum]
  for (const num of targetNums) {
    const target = findByNum(groups, num);
    if (!target) { console.log(`  #${num}: NOT FOUND on board — skipping`); continue; }
    const plan = planBindings(source, target, source.num, num);
    plans.push({ target, plan });
    const off = plan.offset >= 0 ? `+${plan.offset}` : `${plan.offset}`;
    console.log(`  #${num} "${target.name}"  (offset ${off}, ${plan.keptNonTsl} kept)`);
    const addrsThisGroup = new Set();
    for (const d of plan.diffs) {
      console.log(`       ${d.from}  ->  ${d.to}   [${d.output}]`);
      const p = parseTsl(d.to); addrsThisGroup.add(`${p.screen}::${p.display}`);
    }
    // Record each distinct address once per group, so a collision means DIFFERENT groups
    // share an address (a real problem) rather than one group using it for text+color.
    for (const key of addrsThisGroup) {
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(num);
    }
  }

  // duplicate-address warnings
  const dups = [...seen.entries()].filter(([, gs]) => gs.length > 1);
  if (dups.length) {
    console.log('\n  ⚠ WARNING: same TSL address assigned to multiple groups:');
    for (const [key, gs] of dups) console.log(`      ${key} -> groups ${gs.join(', ')}`);
  }

  if (!apply) {
    console.log(`\nDry run complete. ${plans.length} group(s) would be written. Re-run with --apply to write.\n`);
    return;
  }

  console.log(`\nWriting ${plans.length} group(s)…`);
  let ok = 0, fail = 0;
  for (const { target, plan } of plans) {
    try {
      const current = await boardFetch(ip, `/inputs/groups/${target.uuid}`);
      const change = toGroupChange(current, plan.bindings);
      await boardFetch(ip, `/inputs/groups/${target.uuid}`, { method: 'PUT', body: JSON.stringify(change) });
      console.log(`  ✓ #${target.num} ${target.name}`); ok++;
    } catch (e) {
      console.log(`  ✗ #${target.num} ${target.name}: ${e.message}`); fail++;
    }
  }
  console.log(`\nDone: ${ok} applied, ${fail} failed.\n`);
  if (fail) process.exitCode = 1;
}

function requireIp(opts) {
  const ip = opts.ip || process.env.BOARD_IP;
  if (!ip || ip === true) { console.error('error: --ip <board> is required (or set BOARD_IP)'); process.exit(2); }
  return ip;
}

function usage() {
  console.log(`Neuron View — TSL bulk config

  node cli.js dump --ip <board> [--group <n>]
      Inspect real group bindings. Start here to confirm field structure.

  node cli.js copy --ip <board> [--source <n>] [--targets 2-36] [--apply]
      Replicate the source group's TSL tally wiring onto target groups,
      offsetting the display index by (targetNum - sourceNum).
      Dry-run by default; add --apply to write.

  env: BOARD_SCHEME (https), BOARD_PORT (443), BOARD_IP, BOARD_TLS_REJECT_UNAUTHORIZED (false)
`);
}

// ---------- main ----------
(async () => {
  const { cmd, opts } = parseArgs(process.argv);
  const scheme = (opts.scheme || SCHEME).toLowerCase();
  const port = opts.port || PORT;
  const boardFetch = makeClient(scheme, port);
  try {
    if (cmd === 'dump') await cmdDump(boardFetch, opts);
    else if (cmd === 'copy') await cmdCopy(boardFetch, opts);
    else usage();
  } catch (e) {
    console.error(`\nerror: ${e.message}\n`);
    process.exit(1);
  }
})();
