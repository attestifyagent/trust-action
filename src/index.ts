// Attestify Trust — GitHub Action
//
// Signs evidence that this CI run happened and submits it to
// POST /api/trust/v1/evidence, then (optionally) posts the receipt as a
// GitHub Check on the triggering commit. See attestify-os's Trust Build
// Blueprint, Section 03, "Built to spread, not just counted."
//
// Key generation and agent registration NEVER happen here — see this
// repo's README. Both are a one-time, local step (`attestify trust-init`
// in the attestify-os CLI) precisely because this Action's default
// GITHUB_TOKEN cannot write repo secrets, and a CI job's logs are not a
// safe place to hold a private key even briefly. This Action only ever
// reads three pre-existing secrets and signs with them.
//
// Canonicalization and signing below are vendored, not imported from
// attestify-os-sdk on npm, because the currently-published version of
// that package predates Trust entirely (confirmed: latest is 0.1.6, zero
// occurrences of "trust" in its types) — see the attestify-os repo's own
// tracked follow-up to fix that publish gap. These ~30 lines are copied
// verbatim from sdk/typescript/index.ts's trustCanonicalize/trustSign so
// there is exactly one canonicalization implementation to keep in sync,
// not two independently written ones; swap this for the real npm
// dependency once it's published with Trust support.

import * as core from '@actions/core';
import * as github from '@actions/github';
import { randomBytes, createPrivateKey, sign as nodeSign } from 'crypto';

// ─── Vendored from sdk/typescript/index.ts — keep in sync ──────────────────

function trustCanonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`Trust: non-finite number (${String(value)}) cannot be canonicalized.`);
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => {
        if (item === undefined) throw new Error('Trust: array elements cannot be undefined.');
        return trustCanonicalize(item);
      })
      .join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = keys
      .map((key) => {
        const v = obj[key];
        if (v === undefined) return null;
        return `${JSON.stringify(key)}:${trustCanonicalize(v)}`;
      })
      .filter((p): p is string => p !== null);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`Trust: value of type "${t}" cannot be canonicalized.`);
}

function trustSign(message: string, privateKeyB64Url: string): string {
  const keyObject = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: privateKeyB64Url, x: '' },
    format: 'jwk',
  });
  return nodeSign(null, Buffer.from(message, 'utf8'), keyObject).toString('base64url');
}

// ─── Action ──────────────────────────────────────────────────────────────

interface TrustReceipt {
  id: string;
  agent_id: string;
  schema: string;
  content_hash: string;
  assurance_level: string;
  status: string;
  issued_at: string;
}

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
        "setup, not this Action -- run `npx attestify-os trust-init` (attestify-os-sdk's " +
        'CLI) once, then add the three printed values as repo secrets: TRUST_API_KEY, ' +
        'TRUST_AGENT_ID, TRUST_PRIVATE_KEY. See https://attestifyos.com/trust for details.'
    );
    return;
  }

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

  const nonce = randomBytes(16).toString('base64url');
  const signedObject = {
    agent_id:    agentId,
    schema:      'ci-run/v1',
    payload,
    action_basis: 'explicit',
    nonce,
    scope_ref:   null,
  };
  const signature = trustSign(trustCanonicalize(signedObject), privateKey);

  core.info(`Submitting evidence for agent ${agentId}…`);

  const res = await fetch(`${baseUrl}/api/trust/v1/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ ...signedObject, signature }),
  });
  const json = (await res.json()) as { receipt?: TrustReceipt; error?: string; message?: string };

  if (!res.ok || !json.receipt) {
    core.setFailed(`Evidence submission failed (${res.status}): ${JSON.stringify(json)}`);
    return;
  }

  const receipt = json.receipt;
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
