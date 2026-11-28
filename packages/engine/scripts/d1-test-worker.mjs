import { Miniflare } from 'miniflare';

export function createD1TestWorker() {
  return new Miniflare({
    workers: [{
      config: {
        name: 'd1-regression',
        compatibilityDate: '2026-05-11',
        manifest: {
          mainModule: 'fixture.mjs',
          modules: {
            'fixture.mjs': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("fixture") } }',
            },
          },
        },
        env: {
          DB: { type: 'd1', id: 'DB' },
          UPGRADE: { type: 'd1', id: 'UPGRADE' },
        },
      },
    }],
  });
}
