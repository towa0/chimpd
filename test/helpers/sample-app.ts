import path from 'node:path';
import { createTempRepo, repoRoot, type TempRepo } from './temp-repo.js';

export const sampleAppTemplate = path.join(repoRoot, 'fixtures/sample-app');

export interface SampleApp extends TempRepo {
  readonly baseSha: string;
}

export function createSampleApp(): SampleApp {
  const repo = createTempRepo({ template: sampleAppTemplate, linkNodeModules: true });
  const baseSha = repo.commit('Add sample app');
  repo.setRef('refs/remotes/origin/main', baseSha);
  return Object.assign(repo, { baseSha });
}

export const history = {
  boundaryChange(repo: TempRepo): string {
    repo.edit('src/discount.ts', 'orderTotal >= 100', 'orderTotal >= 120');
    return repo.commit('Raise the discount threshold');
  },

  weakTest(repo: TempRepo): string {
    repo.write(
      'test/refund-cap.test.ts',
      [
        "import { it } from 'vitest';",
        "import { refundableAmount } from '../src/payments/refund.js';",
        '',
        "it('caps a refund at the remaining amount', () => {",
        "  refundableAmount({ id: 'ch_2', amount: 100, refunded: 80 }, 50);",
        '});',
        '',
      ].join('\n'),
    );
    return repo.commit('Add a refund cap test');
  },

  staticChange(repo: TempRepo): string {
    repo.edit(
      'src/config.ts',
      "export const SERVICE_NAME = ['sample', 'app'].join('-');",
      "export const SERVICE_NAME = ['sample', 'app'].join('-');\nexport const BACKOFF_MS = SECOND_MS / 4;",
    );
    return repo.commit('Add a backoff constant');
  },
};
