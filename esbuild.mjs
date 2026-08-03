// @ts-nocheck
import * as esbuild from 'esbuild'
import config from '@restorecommerce/dev/esbuild.config.mjs'

await esbuild.build({
  ...config,
  entryPoints: ['./src/start.ts'],
  outfile: './dist/start.cjs',
  tsconfig: 'tsconfig.json',
  sourcemap: false,
  external: [],
});

await esbuild.build({
  ...config,
  entryPoints: ['./src/external-jobs/*.ts'],
  outdir: './dist/external-jobs/',
  outfile: undefined,
  tsconfig: 'tsconfig.json',
  sourcemap: false,
  external: [],
});