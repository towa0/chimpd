import { pathToFileURL } from 'node:url';

const [distDir, targetRoot, rangesJson] = process.argv.slice(2);
const { runMutation } = await import(pathToFileURL(`${distDir}/stryker-adapter/index.js`).href);

const result = await runMutation({
  targetRoot,
  ranges: JSON.parse(rangesJson),
  intensity: 1,
  ignoreStatic: true,
  budgetMs: 150_000,
});
process.stdout.write(JSON.stringify(result));
