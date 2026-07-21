const esbuild = require('esbuild');
const path = require('path');

esbuild.build({
  entryPoints: [path.join(__dirname, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(__dirname, 'dist/index.js'),
  sourcemap: true,
  external: [],
}).then(() => {
  console.log('Build succeeded → dist/index.js');
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
