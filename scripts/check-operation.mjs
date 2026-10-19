import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOperationInputs } from './runtime-operation.mjs';
import { validateReleaseInput } from './release-inputs.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { platformStackName, platformStackStage, recoveryFailureMessage, recoveryViolations, synthStage } from './recovery-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Database recovery targets are a deployment precondition, so a Platform
// operation proves them from local source before anything requests credentials.
// The sealed Service release is not downloaded in this job; the synthesis
// therefore uses the local release-directory fixture. It is a scratch fixture for
// stack-shape checks only and is never uploaded as deployable bytes.
export async function assertDatabaseRecoveryPrecondition(env = process.env) {
  const stage = changedStackNames(env.INFRA_OPERATION).map(platformStackStage).find(Boolean);
  if (!stage) return;
  const stackName = platformStackName(stage);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'anywear-database-recovery-'));
  try {
    const artifactDirectory = path.join(scratch, 'service-artifacts');
    await createTestInputs(artifactDirectory);
    const directory = path.join(scratch, 'cdk.out');
    const files = synthStage({ repository: root, directory, stage,
      inputs: { identityPhase: env.INFRA_IDENTITY_PHASE, ecrImageRetention: env.INFRA_RETENTION_PROTECTION === 'true',
        legacyRoleSource: 'external', artifactDirectory } });
    const templateFile = `${stackName}.template.json`;
    if (!files.includes(templateFile)) throw new Error(`Synthesis did not produce ${templateFile} for stage ${stage}`);
    const violations = recoveryViolations(JSON.parse(await readFile(path.join(directory, templateFile), 'utf8')), { stage });
    if (violations.length) throw new Error(recoveryFailureMessage(violations, { stage, stackName }));
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

validateOperationInputs();
validateReleaseInput();
await assertDatabaseRecoveryPrecondition();
