// Writes CHANGELOG.md from js/changelog.js, the same list the app shows in
// Settings → Version history, so the two never disagree.
//   node scripts/changelog-md.mjs
import fs from 'node:fs';
import path from 'node:path';
import { CHANGELOG } from '../js/changelog.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const lines = [
  '# Changelog',
  '',
  'What changed in each version of Puhemuistio, newest first. The app shows',
  'the same list in Settings → Version history.',
  '',
  '<!-- Generated from js/changelog.js by scripts/changelog-md.mjs. Edit that file, not this one. -->',
  '',
];
for (const e of CHANGELOG) {
  lines.push(`## ${e.version} (${e.date})`, '', ...e.changes.map((c) => `- ${c}`), '');
}
fs.writeFileSync(path.join(root, 'CHANGELOG.md'), lines.join('\n'));
console.log(`CHANGELOG.md: ${CHANGELOG.length} versions`);
