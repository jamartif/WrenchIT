// Copies the static swagger-ui-dist assets to media/swagger-ui so they are
// packaged inside the .vsix (node_modules is excluded through .vscodeignore).
// Its license, NOTICE and bundle license header go along with them, as the
// Apache License 2.0 requires when redistributing.
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'node_modules', 'swagger-ui-dist');
const DEST_DIR = path.join(__dirname, '..', 'media', 'swagger-ui');

const FILES = [
  'swagger-ui-bundle.js',
  'swagger-ui.css',
  'oauth2-redirect.html',
  'oauth2-redirect.js',
  'LICENSE',
  'NOTICE',
  'swagger-ui-bundle.js.LICENSE.txt'
];

fs.mkdirSync(DEST_DIR, { recursive: true });

for (const file of FILES) {
  fs.copyFileSync(path.join(SRC_DIR, file), path.join(DEST_DIR, file));
}

console.log(`WrenchIT: copied ${FILES.length} files from swagger-ui-dist to media/swagger-ui`);
