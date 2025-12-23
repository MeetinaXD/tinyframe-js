import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    checksum: 'src/checksum.ts',
  },
  minify: true,
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: true,
  outExtensions: ({ format, pkgType }) => ({
    js: format === 'cjs' ? '.cjs' : pkgType === 'module' ? '.mjs' : '.js',
    dts: '.d.ts',
  }),
})
