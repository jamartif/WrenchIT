// Copia los assets estáticos de swagger-ui-dist a media/swagger-ui para que
// se empaqueten dentro del .vsix (node_modules se excluye vía .vscodeignore).
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'node_modules', 'swagger-ui-dist');
const DEST_DIR = path.join(__dirname, '..', 'media', 'swagger-ui');

const FILES = [
  'swagger-ui-bundle.js',
  'swagger-ui.css',
  'oauth2-redirect.html',
  'oauth2-redirect.js'
];

fs.mkdirSync(DEST_DIR, { recursive: true });

for (const file of FILES) {
  fs.copyFileSync(path.join(SRC_DIR, file), path.join(DEST_DIR, file));
}

console.log(`WrenchIT: copiados ${FILES.length} assets de swagger-ui-dist a media/swagger-ui`);
