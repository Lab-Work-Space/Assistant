# Local development

Start here if you want to build, test or run the Assistant from source on your machine.

## Local development

```bash
npm ci                   # .npmrc sets ignore-scripts=true: msedge-tts has a `preinstall: npx only-allow pnpm` that would fetch an unpinned package; no dependency needs install scripts (davey and opusscript ship prebuilt binaries / WebAssembly)
npm test                 # unit suite (fake provider, no network)
npm run test:int         # integration suite, needs PostgreSQL: docker compose -f docker-compose.test.yml up -d
npm run build            # tsconfig.build.json (no tests in dist) + copies db/migrations and prompts into dist/
```

Next: [Local mode setup](local-mode-setup.md) (running the whole service on your Mac), then [Env file](env-file.md) and [First run](first-run.md).

Back to the [documentation index](../_index.md).
