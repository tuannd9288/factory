// Reads a JUnit XML report: how many tests ran, failed, errored and were skipped.
//   node .gate/bin/lib/junit.mjs <report.xml>             prints "tests=N failures=F errors=E skipped=S"
//   node .gate/bin/lib/junit.mjs --failures <report.xml>  also names each failing or erroring test
// node --test reports a file that could not load, or that holds no test, as one testcase named after the file as it
// was given; such a testcase is an error when it failed and no test at all when it passed. A missing or empty report
// is an error.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const names = args[0] === '--failures';
const file = names ? args[1] : args[0];

const unescape = (s) => s.replace(/&#10;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescape(m[1]) : '';
};

let xml = '';
try {
  xml = readFileSync(file, 'utf8');
} catch {}
if (!/<testsuites?[\s>]/.test(xml)) {
  console.log(`tests=0 failures=0 errors=1 skipped=0`);
  if (names) console.log(`  error: no JUnit report at ${file}`);
  process.exit(0);
}

const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
const bad = [];
const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
for (let m; (m = testcase.exec(xml)); ) {
  const tag = m[1];
  const body = m[3] ?? '';
  const name = attr(tag, 'name');
  const path = attr(tag, 'file');
  const wrapper = path !== '' && (path === name || path.endsWith(`/${name}`) || basename(path) === name);
  const failure = /<failure\b/.test(body);
  const error = /<error\b/.test(body);
  const message = attr((/<(failure|error)\b[^>]*>/.exec(body) ?? [''])[0], 'message').slice(0, 160);
  if (wrapper) {
    if (failure || error) {
      counts.errors += 1;
      bad.push(`error: ${name} could not run: ${message}`);
    }
    continue;
  }
  if (/<skipped\b/.test(body)) {
    counts.skipped += 1;
    continue;
  }
  counts.tests += 1;
  if (error) {
    counts.errors += 1;
    bad.push(`error: ${name}: ${message}`);
  } else if (failure) {
    counts.failures += 1;
    bad.push(`failed: ${name}: ${message}`);
  }
}
console.log(`tests=${counts.tests} failures=${counts.failures} errors=${counts.errors} skipped=${counts.skipped}`);
if (names) for (const line of bad.slice(0, 20)) console.log(`  ${line}`);
