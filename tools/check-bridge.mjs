#!/usr/bin/env node
// check-bridge.mjs — makes sure the two hand-written mirrors of
// app/src/runtime/bridge.h still agree with it.
//
//   node tools/check-bridge.mjs app/build/wasm-dev/bridge_layout.js
//
// (`task test` runs it for you, as the ctest test `bridge_mirrors`.)
//
// The argument is the compiled app/tests/runtime/bridge_layout.c, which prints
// every offset, size and constant of the bridge block as the C compiler sees
// them. That is the truth. Each mirror is then read and every number it states
// is looked up there:
//
//   dom/runtime/bridge.js   imported here; its exported LAYOUT object, and
//                           bridgeHash()
//   renderer/src/bridge.rs  parsed: the `mod x { pub const Y: u32 = n; }`
//                           items between the two "bridge.h mirror" markers
//                           (a compile-time assert there ties its
//                           bridge_hash() to the same test vector)
//
// A mirror may leave out what it does not use, but a name it states must
// exist in C with the same value. Names are compared ignoring case.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_MIRROR = path.join(repo, 'dom', 'runtime', 'bridge.js');
const RUST_MIRROR = path.join(repo, 'renderer', 'src', 'bridge.rs');
const RUST_BEGIN = 'bridge.h mirror: begin';
const RUST_END = 'bridge.h mirror: end';

const layoutProgram = process.argv[2];
if (!layoutProgram) {
  console.error('usage: node tools/check-bridge.mjs <path to the built bridge_layout.js>');
  process.exit(2);
}

// ── The truth, from the C compiler ──────────────────────────────────────────

const truth = JSON.parse(execFileSync(process.execPath, [layoutProgram], { encoding: 'utf8' }));

const problems = [];

// Checks one mirror, given as { group: { name: number } }. Returns how many
// numbers it compared.
function compare(mirrorName, groups) {
  let compared = 0;
  for (const [group, entries] of Object.entries(groups)) {
    const expected = truth[group.toLowerCase()];
    if (!expected) {
      problems.push(`${mirrorName}: group "${group}" does not exist in bridge.h`);
      continue;
    }
    for (const [name, value] of Object.entries(entries)) {
      const want = expected[name.toLowerCase()];
      if (want === undefined) {
        problems.push(`${mirrorName}: ${group}.${name} does not exist in bridge.h`);
      } else if (want !== value) {
        problems.push(`${mirrorName}: ${group}.${name} is ${value}, but bridge.h says ${want}`);
      }
      compared += 1;
    }
  }
  return compared;
}

// ── dom/runtime/bridge.js ───────────────────────────────────────────────────

// Imported from its text rather than by path: without a package.json saying
// "type": "module", older Node versions would load a .js file as CommonJS.
const jsSource = fs.readFileSync(JS_MIRROR, 'utf8');
const js = await import(`data:text/javascript;base64,${Buffer.from(jsSource).toString('base64')}`);
if (typeof js.LAYOUT !== 'object' || js.LAYOUT === null) {
  problems.push('dom/runtime/bridge.js: no exported LAYOUT object');
}
const jsCompared = compare('dom/runtime/bridge.js', js.LAYOUT ?? {});
if (js.bridgeHash?.('foobar') !== truth.hash.foobar) {
  problems.push('dom/runtime/bridge.js: bridgeHash() disagrees with bridge_hash() in bridge.h');
}

// ── renderer/src/bridge.rs ──────────────────────────────────────────────────

// Reads the marked region: `mod <group> {` opens a group, `pub const <NAME>:
// u32 = <n>;` adds to it. Anything else in there that looks like a constant
// is an error, so nothing in the region can escape the check.
function parseRustMirror(source) {
  const begin = source.indexOf(RUST_BEGIN);
  const end = source.indexOf(RUST_END);
  if (begin < 0 || end < begin) {
    problems.push(`renderer/src/bridge.rs: the "${RUST_BEGIN}" … "${RUST_END}" markers are missing`);
    return {};
  }
  const groups = {};
  let group = null;
  for (const raw of source.slice(begin, end).split('\n').slice(1)) {
    const line = raw.trim();
    const mod = line.match(/^(?:pub(?:\([a-z]+\))? )?mod (\w+) \{$/);
    const constant = line.match(/^pub const (\w+): u32 = (0x[0-9a-fA-F_]+|[0-9_]+);$/);
    if (mod) {
      group = groups[mod[1]] = {};
    } else if (constant && group) {
      group[constant[1]] = Number(constant[2].replaceAll('_', ''));
    } else if (line === '}') {
      group = null;
    } else if (line !== '' && !line.startsWith('//') && !/^#\[[^\]]*\]$/.test(line)) {
      problems.push(`renderer/src/bridge.rs: cannot check this line of the mirror: ${line}`);
    }
  }
  return groups;
}

const rustCompared = compare(
  'renderer/src/bridge.rs',
  parseRustMirror(fs.readFileSync(RUST_MIRROR, 'utf8')),
);

// A mirror that states nothing would pass every comparison; that is a broken
// check, not a matching layout.
if (jsCompared === 0) problems.push('dom/runtime/bridge.js: LAYOUT is empty');
if (rustCompared === 0) problems.push('renderer/src/bridge.rs: no constants found in the mirror');

if (problems.length > 0) {
  console.error('The bridge mirrors do not match app/src/runtime/bridge.h:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nFix the mirror (or add the new name to app/tests/runtime/bridge_layout.c).');
  process.exit(1);
}
console.log(
  `bridge mirrors match bridge.h (dom/runtime/bridge.js: ${jsCompared} values, ` +
    `renderer/src/bridge.rs: ${rustCompared} values)`,
);
