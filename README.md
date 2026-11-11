# Your Rapier workspace

The editor and the shared Door relay run in your Cloudflare account. Markdown files and attachments live in a private R2 bucket as ordinary files. Cloudflare Access signs in your browsers and authorizes your agents through Managed OAuth, which Cloudflare currently labels Beta.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fjackskip22%2Frapier-workspace)

## Deploy into your account

1. Open the published template's **Deploy to Cloudflare** button. Sign in to Cloudflare and the Git provider, and let Cloudflare create your repository copy. Choose the Workers Free plan and complete R2's activation prompts. The template needs one private R2 bucket and the `WorkspaceFiles`, `RapierDocument`, and `RapierBudget` SQLite Durable Objects. Cloudflare provisions these resources from the Wrangler file.
2. Keep Node **22.23.4**. The editor is already built in this package: leave the build command empty and use `npm run deploy` as the deploy command. The lock file pins the dependencies. Save the resulting `https://<worker>.<account-subdomain>.workers.dev` address.
3. In **Zero Trust**, select the Free plan and use **Cloudflare** as the identity provider, with **Restrict to account members** enabled. New Zero Trust organizations already receive this default. An Allow policy with the **Cloudflare Account Member** selector and no account ID refers to your current account.
4. Under **Zero Trust → Access controls → Applications**, create a **self-hosted application** for the exact Worker hostname, covering all paths. Use the account-member policy and Cloudflare login. Choose hostname-based protection: Cloudflare's Worker-level Access switch currently rejects WebSocket upgrades, which the shared editor needs.
5. Edit that Access application's **Advanced settings**, enable **Managed OAuth**, and save. Set the agent client's allowed redirect URI; enable localhost or loopback redirects only for clients that use them. Cloudflare recommends an access token lifetime of 5–15 minutes and a grant session of 1–2 weeks.
6. Open the Worker address in your browser and sign in. Connect an MCP client to the same address followed by `/mcp`; its authorization flow should open Cloudflare's login and consent pages.

The button provisions the Worker and storage. Access and Managed OAuth still require the dashboard steps above; they are not resource types supported by the deployment button. These steps require no API token or account ID pasted into Rapier. The Worker rejects requests without a native authenticated Access context, including the interval before Access is configured.

See Cloudflare's [deployment button](https://developers.cloudflare.com/workers/platform/deploy-buttons/), [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/), [Worker Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), and [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) instructions.

## Your files and allowances

The bucket keeps ordinary source files separately from Rapier's recovery records:

| R2 key | Contents |
| --- | --- |
| `documents/<filename>` | Source for a shared Door document. |
| `notes/<filename>` | A file in the existing Notes catalog. |
| `documents/attachments/`, `documents/audio/`, `notes/attachments/`, `notes/audio/` | Original attachment and audio bytes. |
| `.rapier/notes/` | The existing Notes index and journal records. |
| `.rapier/documents/<id>/<slot>.json` | Bounded document recovery and history: two working slots and at most one held candidate, never more than three slots per document. |

You can read the source files with ordinary R2 tools. A stale conditional save is refused so that an outside application's later write is preserved. A document's `document.delete` operation retires its relay binding and private recovery history; its plain source file remains in R2. Permanently delete an authored file through your account's R2 controls. Export anything to keep before removing storage resources.

The current limits in `src/workspace/files.mjs` apply to this deployment:

| Allowance | Limit |
| --- | ---: |
| Markdown source per file | 2 MiB |
| Attachment or other file object | 16 MiB |
| Document recovery snapshot | 8 MiB |
| Tracked storage, including recovery | 512 MiB |
| Indexed files and Notes metadata objects | 4,096 |
| Linked shared documents | 128 |
| Workspace request admissions per UTC day | 12,000 |
| Admitted writes per UTC day | 4,000 |
| Estimated storage work units per UTC day | 60,000 |
| Additional read/recovery request admissions per UTC day | 12,000 |
| Additional read/recovery listing and cleanup attempts per UTC day | 1,024 |
| Additional read/recovery work units per UTC day | 240,000 |

Recording recovery supports at most 32 live recording leases and keeps the editor's existing whole-Blob capture fallback.

An interrupted document write can leave a candidate whose outcome is unknown. Rapier retains that candidate and its receipt in a counted private slot, even when a later normal commit succeeds. A second unknown outcome retains its in-flight slot and refuses further commits until the conflict is resolved. Held or conflicted documents cannot be retired. An authenticated owner can download a held candidate with `GET /workspace/held?address=<document-id>`. The response contains the exact recovery JSON bytes, with `X-Rapier-Held-Key` and `X-Rapier-Held-Hash` identifying that candidate. The download verifies the bounded body and its SHA-256 before returning it and leaves source, selected history and pending work unchanged. Recovery refuses to attach a document's history to changed source bytes.

An uncertain Notes PUT keeps its original receipt and journal. Seeing the old file does not prove that the PUT cannot complete later. Rapier does not resend it to R2; recovery requires matching bytes, content type, request receipt and current generation. The accepted old bytes remain downloadable when their identity can be verified. A request with no provable completion remains held.

Each admitted request is counted once. Listing and mutation attempts reserve their allowance before the operation, and interrupted cleanup requires a fresh reservation when retried. When the ordinary allowance runs out, reads, exports, leases and cleanup can use the additional finite allowance. New file writes cannot use it. Exhausting both allowances stops further work until the next UTC day. Releasing an existing Notes or recording lease remains possible.

The optional SQLite body store is off by default. Its cold-read inventory uses the additional recovery allowance first. Repeated Notes directory listings reuse bounded name sets while their stored membership generation remains current. Listings do not authorize overwriting a file; saves still require the current source revision. Backup reads and failed attempts remain charged.

The request and storage counters are conservative application allowances; they are not Cloudflare's billing meters. These limits do not guarantee an R2 billing cap. Direct writes through account tools and work by other applications can consume additional storage and operations. Check actual account usage during acceptance and keep R2's public access disabled.

## Account acceptance

Use a new test account and a disposable document. Record the deployed version and Cloudflare's resource names.

1. Confirm an unsigned browser and a request with a fabricated Access header cannot read a file or use the relay. Confirm the bucket's public access is disabled.
2. Connect an agent through `/mcp`, create a document, and open its editor link on two signed-in devices. Make independent edits from each browser and from the agent. Verify the exact Markdown bytes converge, and Undo removes the selected edit while retaining later independent work.
3. Save and reopen a Markdown file and an attachment. Download them directly from your R2 bucket and compare their exact bytes with the inputs. Check stale-write rejection and the upload, file count, and storage allowances. Record actual Worker CPU, requests, and Durable Object usage during this exercise.
4. Test the client's inline editor separately if it offers one. An inline host has its own cookie and cross-origin behavior; a successful MCP request or local bundle does not prove that embedded assets load there.
5. Sign out through the Worker's `/cdn-cgi/access/logout` endpoint. Close the editor connections, then confirm browser reconnects and agent requests require authorization again. Cloudflare documents a 20–30 second token revocation delay and logout across the user's Access applications. Test an already-open connection separately; do not infer its revocation from a new HTTP request.
6. Retire the disposable document and verify its relay and private history cannot be reopened, while its ordinary R2 source remains readable. Use the account's R2 controls to permanently delete the disposable source and attachment, then verify their keys are absent. After exporting anything to keep, remove the test Worker, its Durable Object namespaces, the R2 bucket, the Access application, and the test repository copy in their owning dashboards. Deleting a Worker alone is not a storage deletion receipt.

Cloudflare publishes the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Object allowances](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2 allowances](https://developers.cloudflare.com/r2/pricing/), and [Access session behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/). The application caps its own work; other applications in the account also consume these allowances. R2 usage beyond its included allowance is billable.

## Build and review the isolated template

From Rapier's source checkout, use the canonical Node version and build the reader profile followed by the full profile. Then stage into a new directory:

```sh
npm ci --prefix mcp
RAPIER_PROFILE=reader node tools/build.mjs
node tools/build.mjs
node tools/stage-workspace.mjs /tmp/rapier-workspace-template
```

For a local development build, set `RAPIER_PACK=fast` on the build commands and pass `--development` to the stager. This labels the package as development. A maintainer can supply `--repository=<public-GitHub-or-GitLab-template-URL>` to insert the real deployment button when publishing is authorized. `--source=<repo-directory>` and `--assets=<built-dist/chatgpt-directory>` select explicit build inputs; their receipts must agree.

Inside the staged directory, run:

```sh
npm ci
npm run check
```

`check` performs a local Wrangler bundle dry run. It creates no Cloudflare deployment. Inspect its total uncompressed upload size against the current 64 MiB limit; CPU, memory, WebSockets, account login, and the acceptance steps still need their own evidence.

The stager follows literal runtime imports and retains their complete source closure under `src/`, copies pinned dependency metadata and license notices, and verifies the built editor against `dist/BUILD.json`. `BUILD.json` in the result records source and asset hashes. Existing output directories are refused.

The generated `src/workspace/app-assets.mjs` imports the exact compiled files as Worker **Data modules** and exports the in-process `workspaceAssets.fetch()` helper used by the shared rendering owner. There is no Cloudflare Static Assets binding: its internal router does not forward `ctx.access`. See [module bundling](https://developers.cloudflare.com/workers/wrangler/bundling/) and the [declarative SQLite exports configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
