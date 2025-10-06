import * as esbuild from 'esbuild'
import { commonifierPlugin } from '@restorecommerce/dev'

await esbuild.build({
  entryPoints: ['./src/start.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'lib/start.cjs',
  minify: true,
  treeShaking: true,
  sourcemap: 'linked',
  plugins: [commonifierPlugin],
});

await esbuild.build({
  entryPoints: ['./src/external-jobs/*.ts'],
  bundle: true,
  platform: 'node',
  outdir: 'lib/external-jobs/',
  minify: true,
  treeShaking: true,
  sourcemap: 'linked',
  outExtension: {
    '.js': '.cjs'
  },
  plugins: [commonifierPlugin],
});