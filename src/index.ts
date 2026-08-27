// Attestify Trust — GitHub Action
//
// Signs evidence that this CI run happened and submits it via
// attestify-os-sdk's attestify.trust.submitEvidence(), then (optionally)
// posts the receipt as a GitHub Check on the triggering commit. See
// attestify-os's Trust Build Blueprint, Section 03, "Built to spread, not
// just counted."
//
// Key generation and agent registration NEVER happen here — see this
// repo's README. Both are a one-time, local step (`attestify trust-init`,
// the `attestify` CLI package) precisely because this Action's default
// GITHUB_TOKEN cannot write repo secrets, and a CI job's logs are not a
// safe place to hold a private key even briefly. This Action only ever
// reads three pre-existing secrets and signs with them.
//
// Uses attestify-os-sdk directly (>=0.2.0, the first version with Trust
// support) rather than a vendored canonicalizer — earlier versions of this
// file rolled their own copy of sdk/typescript/index.ts's
// trustCanonicalize/trustSign because the published package predated
// Trust entirely at the time. That's fixed now; this is the real
// dependency, one canonicalization implementation, not two.

import * as core from '@actions/core';
import * as github from '@actions/github';
import { createClient, type TrustReceipt } from 'attestify-os-sdk';

async function run(): Promise<void> {
  const apiKey     = core.getInput('api-key', { required: true });
  const agentId    = core.getInput('agent-id', { required: true });
  const privateKey = core.getInput('private-key', { required: true });
  const baseUrl    = core.getInput('base-url') || 'https://attestifyos.com';
  const postCheck  = core.getInput('post-check') !== 'false';
  const token      = core.getInput('github-token');

  if (!apiKey || !agentId || !privateKey) {
    core.setFailed(
      'Missing one of api-key/agent-id/private-key. These come from a one-time local ' +
        "setup, not this Action -- run `npx attestify trust-init` (the `attestify` CLI " +
        'package) once, then add the three printed values as repo secrets: TRUST_API_KEY, ' +
        'TRUST_AGENT_ID, TRUST_PRIVATE_KEY. See https://attestifyos.com/trust for details.'
    );
    return;
  }

  const attestify = createClient({ apiKey, baseUrl });

  const ctx = github.context;
  const runUrl = `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/actions/runs/${ctx.runId}`;

  // Deliberately narrow: this attests that a registered agent's CI run
  // happened, on this commit, in this repo, at this time -- not a claim
  // about what any other step in the calling workflow actually did. See
  // this repo's README on what this schema does and doesn't assert.
  const payload = {
    repo:         `${ctx.repo.owner}/${ctx.repo.repo}`,
    commit_sha:   ctx.sha,
    ref:          ctx.ref,
    workflow:     ctx.workflow,
    run_id:       String(ctx.runId),
    run_url:      runUrl,
    triggered_by: ctx.actor,
  };

  core.info(`Submitting evidence for agent ${agentId}…`);

  let receipt: TrustReceipt;
  try {
    receipt = await attestify.trust.submitEvidence(
      { agentId, schema: 'ci-run/v1', payload },
      privateKey
    );
  } catch (e) {
    core.setFailed(`Evidence submission failed: ${(e as Error).message}`);
    return;
  }

  const receiptUrl = `${baseUrl}/trust/verify?receipt=${encodeURIComponent(receipt.id)}`;

  core.info(`✅ Receipt issued: ${receipt.id} (${receipt.assurance_level})`);
  core.setOutput('receipt-id', receipt.id);
  core.setOutput('receipt-url', receiptUrl);
  core.setOutput('assurance-level', receipt.assurance_level);

  if (!postCheck) return;

  try {
    const octokit = github.getOctokit(token);
    await octokit.rest.checks.create({
      owner:       ctx.repo.owner,
      repo:        ctx.repo.repo,
      name:        'Attestify Trust',
      head_sha:    ctx.sha,
      status:      'completed',
      conclusion:  'success',
      output: {
        title:   `Verified — ${receipt.assurance_level}`,
        summary: `Signed evidence for this run was submitted to Attestify Trust and issued receipt [\`${receipt.id}\`](${receiptUrl}).\n\nAnyone can independently verify it — no account, no API key: ${receiptUrl}`,
      },
    });
    core.info('✅ Posted PR check');
  } catch (e) {
    // A failed check post shouldn't fail the whole Action -- the receipt
    // already exists and is independently verifiable regardless of
    // whether this specific cosmetic step succeeded (commonly a
    // permissions issue: the calling workflow needs `checks: write`).
    core.warning(
      `Evidence was submitted successfully (${receipt.id}), but posting the PR check failed: ` +
        `${(e as Error).message}. Does the calling workflow have \`permissions: checks: write\`?`
    );
  }
}

run().catch((e) => core.setFailed((e as Error).message));
