#!/usr/bin/env node
// Fails when a function call hits a local variable that hides an outer
// function of the same name. Example:
//
//   import { scanTags } from '../services/noteCommands';
//   …
//   const scanTags = allMatches(response, /\[TRADE_SCAN…/gi); // an array now
//   …
//   scanTags(response)                     // "Object is not a function"
//
// That exact slip in CommandScreen's reply loop killed every persona reply on
// the phone ("<persona> replied, but a step after the reply failed — Object is
// not a function"), and it was read as a Hermes matchAll bug for two builds.
// Hermes's release stack only gives bytecode offsets, so this kind of mistake
// is cheap to catch here and expensive to find from a crash log.
//
//   node scripts/check-shadowed-calls.js [files…]   (default: the app's src/, App.js, index.js)
// Run before every APK build (.github/workflows/build.yml).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const repo = path.resolve(__dirname, '..');
let files = process.argv.slice(2);
if (!files.length) {
  files = execFileSync('git', ['ls-files', 'src', 'App.js', 'index.js'], { cwd: repo }).toString()
    .split('\n').filter((f) => /\.jsx?$/.test(f)).map((f) => path.join(repo, f));
}

const isFunctionInit = (n) => !!n && (
  /Function|Arrow/.test(n.type)
  || (n.type === 'CallExpression' && /^(useCallback|useMemo|memo|forwardRef|debounce|throttle)$/.test(n.callee.name || n.callee.property?.name || ''))
  || n.type === 'ConditionalExpression' || n.type === 'LogicalExpression' // a fallback between functions
  || n.type === 'MemberExpression' || n.type === 'Identifier');            // an alias of another function

const problems = [];
for (const f of files) {
  let ast;
  try {
    ast = parser.parse(fs.readFileSync(f, 'utf8'), { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  } catch (e) { problems.push(`${path.relative(repo, f)}: couldn't parse (${e.message})`); continue; }
  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (callee.type !== 'Identifier') return;
      const b = p.scope.getBinding(callee.name);
      if (!b || !['var', 'let', 'const'].includes(b.kind)) return;
      const decl = b.path.node;
      if (decl.id && decl.id.type !== 'Identifier') return; // destructured: const { fn } = require(…)
      if (isFunctionInit(decl.init)) return;
      const outer = b.scope.parent && b.scope.parent.getBinding(callee.name);
      if (!outer) return;
      problems.push(`${path.relative(repo, f)}:${p.node.loc.start.line} calls ${callee.name}(), but that's the local ${b.kind} from line ${decl.loc.start.line}, not the ${outer.kind === 'module' ? 'import' : outer.kind} from line ${outer.path.node.loc.start.line} — rename the local`);
    },
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check-shadowed-calls: ${files.length} files, nothing calls a shadowed function`);
