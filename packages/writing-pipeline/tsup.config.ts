import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/voice/index.ts',
    'src/voice/anti-slop/index.ts',
    'src/cli/write.ts',
    'src/cli/stress.ts',
  ],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
});
