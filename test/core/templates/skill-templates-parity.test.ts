import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  type SkillTemplate,
  getApplyChangeSkillTemplate,
  getArchiveChangeSkillTemplate,
  getBulkArchiveChangeSkillTemplate,
  getContinueChangeSkillTemplate,
  getExploreSkillTemplate,
  getFeedbackSkillTemplate,
  getFfChangeSkillTemplate,
  getNewChangeSkillTemplate,
  getOnboardSkillTemplate,
  getOpsxApplyCommandTemplate,
  getOpsxArchiveCommandTemplate,
  getOpsxBulkArchiveCommandTemplate,
  getOpsxContinueCommandTemplate,
  getOpsxExploreCommandTemplate,
  getOpsxFfCommandTemplate,
  getOpsxNewCommandTemplate,
  getOpsxOnboardCommandTemplate,
  getOpsxSyncCommandTemplate,
  getOpsxProposeCommandTemplate,
  getOpsxProposeSkillTemplate,
  getOpsxVerifyCommandTemplate,
  getSyncSpecsSkillTemplate,
  getVerifyChangeSkillTemplate,
} from '../../../src/core/templates/skill-templates.js';
import { generateSkillContent } from '../../../src/core/shared/skill-generation.js';

const EXPECTED_FUNCTION_HASHES: Record<string, string> = {
  getExploreSkillTemplate: '55a2a1afcba0af88c638e77e4e3870f65ed82c030b4a2056d39812ae13a616be',
  getNewChangeSkillTemplate: '42bce84f35d9bd82036a9bd4f1362a4c5e17a6ffa183fc3dccaaca079a415f63',
  getContinueChangeSkillTemplate: '244fba7f5885f916467d5812d943cf451414e5e40a298375feb6e175ebed4f19',
  getApplyChangeSkillTemplate: 'f60abe537385f8c00b2a90131db2e9ba5ce43b848435adfc7e13844de2fb1190',
  getFfChangeSkillTemplate: '5d79f3e8faf2cd331db42f9cee7e237ccba094d5fe5815ee295748dda8d1fc32',
  getSyncSpecsSkillTemplate: 'c99ddba1ee01bfea951cee620e790202b8900e12322a4b05b3b7b8d0b253c9b4',
  getOnboardSkillTemplate: '819a2d117ad1386187975686839cb0584b41484013d0ca6a6691f7a439a11a4a',
  getOpsxExploreCommandTemplate: '91353d9e8633a3a9ce7339e796f1283478fca279153f3807c92f4f8ece246b19',
  getOpsxNewCommandTemplate: 'f236e5a55860ba38afbb269561a50798de0442794816328cd8add11d34036cc7',
  getOpsxContinueCommandTemplate: 'd5ce1f7dfe08007edf6515839f66dfb0003ceae028b1541ca75310b9b9b9e1c3',
  getOpsxApplyCommandTemplate: 'c18da65720cca7ff32d93ed39f72dca49e608fe1a20fc6691b904e6303f703ff',
  getOpsxFfCommandTemplate: '22cdcd6d48d8efa6feb7b6616fbbfbc62e6b985a5db4fdd8e112ec0f42fc384f',
  getArchiveChangeSkillTemplate: '27ac0a309d83484112c1f734056eb0de8973e084a0f41476a0bd2612c731b0b4',
  getBulkArchiveChangeSkillTemplate: 'df57c9202af44bf3857b437b178801d531f9160665290adb3be4e1c1b42b8754',
  getOpsxSyncCommandTemplate: '6be1dd3213b9b34e3e3628f9ab7901679f813888cca2c23bdc58b21df957e39d',
  getVerifyChangeSkillTemplate: '4c485e1c1f4cf5e4985fbfa31f201c52b8c95c0353aaf05d990b151967014c88',
  getOpsxArchiveCommandTemplate: 'fb10b5cbb66648e20b50f4613174f858f443e4a0734a22d05b47b43512e8b713',
  getOpsxOnboardCommandTemplate: '10052d05a4e2cdade7fdfa549b3444f7a92f55a39bf81ddd6af7e0e9e83a7302',
  getOpsxBulkArchiveCommandTemplate: '50e5eb40721d9dd1ec957e1b0dc32a0759b01919a81aca5d61e251422087e1d1',
  getOpsxVerifyCommandTemplate: '62d9a700b0caee6965f6ff1599d0e4324f3f7d728c8d37b146e2c4500966c747',
  getOpsxProposeSkillTemplate: '5749cc000969a8b9150f06a4f5e612d8bdcb25823c8a2bf36e7a67925b27e3ad',
  getOpsxProposeCommandTemplate: '48eb7b453b9ef2a3e614b63ae263b19f1e4a6e759038603bfd7de1c8e3a41947',
  getFeedbackSkillTemplate: 'd7d83c5f7fc2b92fe8f4588a5bf2d9cb315e4c73ec19bcd5ef28270906319a0d',
};

const EXPECTED_GENERATED_SKILL_CONTENT_HASHES: Record<string, string> = {
  'openspec-explore': '90463d00761417dfbca5cb09361adcf8bbdbbb24000b86dd03647869a4104479',
  'openspec-new-change': '9b82d92fe4a4ae8c0ea1da26b02898c2a039c94cb2c672d556a9cb9935f8cad5',
  'openspec-continue-change': 'fb3caf2645c1eda283b1f10f153bc0eaf8bc0b24c7627499600bbc075a92d879',
  'openspec-apply-change': 'fa740ab64ad1cf611652c827c718f8e6cc1e115773db1b898b449086d722f73e',
  'openspec-ff-change': '8f658c2ab147dbcebbcf2c52f8929b051b84b48134aa79963ff6a1c02703cfde',
  'openspec-sync-specs': '05be34248e5e878b409464afa55f03efee2a99a4c47c9056b36fd93e79463ae6',
  'openspec-archive-change': 'b76114769b642fd792f5f1dae1d5cd2e3944983bb3926bce508b2f71ffef3f81',
  'openspec-bulk-archive-change': 'c88c37b29f0ebc64f6c0437f1d514254ddd68b0301e4586b579f97db2ce7d289',
  'openspec-verify-change': '184fab12876f6c1951e30da243a53b5bd8044d588da3b30435b8864ecf10b638',
  'openspec-onboard': 'dbce376cf895f3fe4f63b4bce66d258c35b7b8884ac746670e5e35fabcefd255',
  'openspec-propose': 'cef32505846f7d50a5de72a9527b6e7c80c1f04c6f142f484b7503d1515f42cd',
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('skill templates split parity', () => {
  it('preserves all template function payloads exactly', () => {
    const functionFactories: Record<string, () => unknown> = {
      getExploreSkillTemplate,
      getNewChangeSkillTemplate,
      getContinueChangeSkillTemplate,
      getApplyChangeSkillTemplate,
      getFfChangeSkillTemplate,
      getSyncSpecsSkillTemplate,
      getOnboardSkillTemplate,
      getOpsxExploreCommandTemplate,
      getOpsxNewCommandTemplate,
      getOpsxContinueCommandTemplate,
      getOpsxApplyCommandTemplate,
      getOpsxFfCommandTemplate,
      getArchiveChangeSkillTemplate,
      getBulkArchiveChangeSkillTemplate,
      getOpsxSyncCommandTemplate,
      getVerifyChangeSkillTemplate,
      getOpsxArchiveCommandTemplate,
      getOpsxOnboardCommandTemplate,
      getOpsxBulkArchiveCommandTemplate,
      getOpsxVerifyCommandTemplate,
      getOpsxProposeSkillTemplate,
      getOpsxProposeCommandTemplate,
      getFeedbackSkillTemplate,
    };

    const actualHashes = Object.fromEntries(
      Object.entries(functionFactories).map(([name, fn]) => [name, hash(stableStringify(fn()))])
    );

    expect(actualHashes).toEqual(EXPECTED_FUNCTION_HASHES);
  });

  it('preserves generated skill file content exactly', () => {
    // Intentionally excludes getFeedbackSkillTemplate: skillFactories only models templates
    // deployed via generateSkillContent, while feedback is covered in function payload parity.
    const skillFactories: Array<[string, () => SkillTemplate]> = [
      ['openspec-explore', getExploreSkillTemplate],
      ['openspec-new-change', getNewChangeSkillTemplate],
      ['openspec-continue-change', getContinueChangeSkillTemplate],
      ['openspec-apply-change', getApplyChangeSkillTemplate],
      ['openspec-ff-change', getFfChangeSkillTemplate],
      ['openspec-sync-specs', getSyncSpecsSkillTemplate],
      ['openspec-archive-change', getArchiveChangeSkillTemplate],
      ['openspec-bulk-archive-change', getBulkArchiveChangeSkillTemplate],
      ['openspec-verify-change', getVerifyChangeSkillTemplate],
      ['openspec-onboard', getOnboardSkillTemplate],
      ['openspec-propose', getOpsxProposeSkillTemplate],
    ];

    const actualHashes = Object.fromEntries(
      skillFactories.map(([dirName, createTemplate]) => [
        dirName,
        hash(generateSkillContent(createTemplate(), 'PARITY-BASELINE')),
      ])
    );

    expect(actualHashes).toEqual(EXPECTED_GENERATED_SKILL_CONTENT_HASHES);
  });
});
