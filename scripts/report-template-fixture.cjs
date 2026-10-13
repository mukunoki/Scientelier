// Unit/integration tests do not need copyrighted upstream styles or TeX.
// TeX rendering smoke tests must explicitly use the installed official preset.
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
function reportTemplateFixture(root) {
  const directory = join(root, 'templates', 'ipsj'); mkdirSync(directory, { recursive: true });
  for (const name of require('./install-ipsj.cjs').FILES) writeFileSync(join(directory, name), `% Synthetic test-only template: ${name}\n`);
  return directory;
}
module.exports = { reportTemplateFixture };
