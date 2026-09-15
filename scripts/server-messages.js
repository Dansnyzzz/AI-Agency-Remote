#!/usr/bin/env node
/**
 * Every sentence the server can put in front of a person, read from the source.
 *
 * The server authors its own messages — an HTTP error, a status line while a
 * turn runs, the text of a thrown Error that a route hands back. They are
 * English, and they reach an interface that can be in another language. This
 * lists them so `server/i18n` can be checked for a translation of each one,
 * rather than trusting a hand-kept list to notice a new sentence.
 *
 * What counts as a message (the places a string reaches a response):
 *   - `new Error(…)`                         thrown text a route may return
 *   - `{ error: … }`, `{ message: … }`,      the JSON and SSE payload fields,
 *     `{ reason: … }`, `{ help: … }`,
 *     `{ placeholder: … }`, `{ hint: … }`,
 *     `{ blurb: … }`                         (a suggested MCP server's line)
 *   - `return …` in a function named `…Reason`  (why an action needs approval)
 *
 * A literal becomes itself; a template becomes its shape with `{0}`, `{1}`… in
 * place of each `${…}`; `'a' + 'b'` concatenation is joined. Anything else
 * (a variable, a call) is not a sentence this can read and is skipped.
 *
 *   node scripts/server-messages.js          → one message per line
 *   node scripts/server-messages.js --json   → [{ text, file, line }]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELDS = new Set(['error', 'message', 'reason', 'help', 'placeholder', 'hint', 'blurb']);

/** A sentence has words in it; an id, a code or a path does not. */
const isSentence = (text) => /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text) && !/^[a-z0-9_.:/-]+$/i.test(text);

function shapeOf(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    let out = '';
    node.quasis.forEach((quasi, i) => {
      out += quasi.value.cooked;
      if (i < node.expressions.length) out += `{${i}}`;
    });
    return out;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = shapeOf(node.left);
    const right = shapeOf(node.right);
    if (left == null || right == null) return null;
    // Renumber the right side's holes so they follow the left side's.
    const offset = (left.match(/\{\d+\}/g) || []).length;
    return left + right.replace(/\{(\d+)\}/g, (_, n) => `{${Number(n) + offset}}`);
  }
  return null;
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

export function serverMessages() {
  const found = [];
  for (const file of filesUnder(path.join(ROOT, 'server'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel.startsWith('server/i18n/')) continue;
    const source = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
    } catch {
      continue;
    }
    const take = (valueNode) => {
      // Either branch of `a ? 'x' : 'y'` can be the sentence.
      if (valueNode?.type === 'ConditionalExpression') {
        take(valueNode.consequent);
        take(valueNode.alternate);
        return;
      }
      const text = shapeOf(valueNode);
      if (text != null && isSentence(text)) found.push({ text: text.trim(), file: rel, line: valueNode.loc.start.line });
    };
    walk(ast, (node) => {
      if (node.type === 'FunctionDeclaration' && /Reason$/.test(node.id?.name || '')) {
        walk(node.body, (inner) => {
          if (inner.type === 'ReturnStatement') take(inner.argument);
        });
      }
      if ((node.type === 'NewExpression' || node.type === 'CallExpression') && node.callee.type === 'Identifier' && /Error$/.test(node.callee.name)) {
        take(node.arguments[0]);
      }
      if (node.type === 'Property' && !node.computed) {
        const name = node.key.type === 'Identifier' ? node.key.name : node.key.value;
        if (FIELDS.has(name)) take(node.value);
      }
    });
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = serverMessages();
  if (process.argv.includes('--json')) console.log(JSON.stringify(list, null, 1));
  else for (const text of [...new Set(list.map((m) => m.text))]) console.log(text);
}
