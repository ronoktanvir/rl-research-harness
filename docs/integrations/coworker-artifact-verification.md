# CoworkeRL artifact byte verification

The artifact verifier checks a staged source inventory and explicit input-file hashes against an immutable attempt preview. **A matching receipt is byte evidence, not permission to launch.** It always returns `launchSupported: false` and lists the execution, environment and native checks that remain pending.

The APIs live in `src/integrations/coworker/artifact-verification.ts`. They run only a trusted harness-owned Python reader in isolated, no-site mode. They do not import CoworkeRL, execute its trainer interpreter, load tensors, inspect credentials, contact providers or run native preflight. The source directory must be an explicitly selected staged export without secrets; this API is not a request to inventory a user's home directory or an unrestricted research checkout.

## API and declaration boundary

`inventoryCoworkerSource(root, options?)` returns either `{ok: true, inventory}` or `{ok: false, problem}`. The inventory contains the complete relative entry list, root executable bits, the algorithm identifier and the resulting SHA-256. It can be used to construct a new attempt declaration.

`verifyCoworkerArtifacts(plan, {sourceInventoryAlgorithm}, options?)` returns a frozen, digest-bound `CoworkerArtifactReceipt`. The mandatory algorithm value is `COWORKER_SOURCE_INVENTORY_ALGORITHM`, currently `coworker-source-inventory-v1`. The verifier reconstructs the supplied attempt preview from its declarations and requires exact canonical equality, including its command and digest, before reading any artifact. The receipt binds that exact plan digest, action ID and manifest digest. Caller changes after invocation cannot change the retained proposal.

The earlier preview's `source.treeSha256` did not specify a tree-hash algorithm. **Existing hashes cannot silently acquire the new semantics.** Create the staged inventory under this algorithm, put its hash into a new configuration and corresponding manifest, and rebuild the preview. A matching inventory also does not authenticate the declared Git revision; that remains a separate pending check. Neither a `HEAD` file nor a caller-supplied matching hash establishes provenance from the inspected upstream commit.

Example sequence, using explicitly selected staged paths and an already constructed attempt input:

```ts
const result = await inventoryCoworkerSource(stagedSourceRoot);
if (!result.ok) throw new Error(result.problem);
// Bind result.inventory.sha256 into source.treeSha256 and rebuild the manifest
// and attempt preview. Do not modify a previously registered manifest in place.
const receipt = await verifyCoworkerArtifacts(plan, {
  sourceInventoryAlgorithm: COWORKER_SOURCE_INVENTORY_ALGORITHM,
});
```

These functions do not register a run, reserve resources or persist the receipt. A controller must retain the returned record through its normal authoritative evidence path. Its SHA-256 detects changed content; it is not a signature or independent attestation.

## Reproducible inventory definition

The source hash is SHA-256 of the UTF-8 canonical JSON encoding of this object:

```text
{algorithm: "coworker-source-inventory-v1", rootExecutableBits, entries}
```

Canonical encoding uses the harness ledger encoder: object keys sorted lexicographically, compact JSON, no trailing newline. Entries are sorted by the UTF-8 bytes of their complete relative path. Every directory below the root appears as `{path, kind: "directory", executableBits}`, including empty directories. Every regular file appears as `{path, kind: "file", executableBits, bytes, sha256}`. `executableBits` is the numeric `st_mode & 0o111` mask. File hashes cover raw bytes, including non-text data. Root path, timestamps, inode numbers and read/write permission bits are not part of the reproducible digest. Root executable bits are included separately.

There are no implicit exclusions: `.git`, generated files and hidden files count if present. Consequently a dedicated source export is preferable to a mutable checkout. The reader rejects symlinks in the tree or any root/path ancestor, hardlinked regular files, special files, noncanonical traversal, control characters, invalid UTF-8 names and backslash path components. A directory's ordinary link count is not treated as a file hardlink; directory traversal uses no-follow directory descriptors.

The combined verification also hashes the declared experiment manifest and numerical qualification receipt. A resume request adds the explicitly declared `checkpoint.json` and origin `run-evidence.json`. It reads no other files under the input root. Repeated references consume their actual repeated read bytes/counts. The initial adapter directory is not scanned: its native tensor fingerprint has a different meaning from this source inventory algorithm.

## Bounds and mutation evidence

The defaults are also hard upper bounds: 4,096 regular-file reads, 2,048 source directories including the root, directory depth 32 below either the source or input root, 64 MiB per file and 256 MiB total bytes. Callers may lower those values. The directory-count limit applies to source enumeration; selected input ancestors are separately bounded by depth and the maximum four explicit files. Directory enumeration stops at its entry bound; retained source metadata has an additional 1 MiB accounting limit, and reader output is capped at 2 MiB. Incoming previews have a 1 MiB encoded limit with structural and string-byte checks before reconstruction. The default process timeout is 30 seconds, configurable from 1 millisecond to 60 seconds; cancellation is supported. Exhaustion, timeout and cancellation produce unavailable evidence, never a partially passing receipt.

The reader pins root ancestors with directory descriptors, uses no-follow relative opens, checks regular-file type and single-link status, and compares size, mode, inode, link count and nanosecond modification/change times around each read. A second tree walk checks the original metadata after explicit inputs have been read. Input directory identities and file metadata are checked again, and root pathname bindings are rechecked before returning. A renamed ancestor cannot redirect an in-progress descriptor read to an unrelated file.

These checks reject detected ordinary concurrent changes. They do not provide an atomic filesystem snapshot, stop a writer after the final check, survive arbitrary mount manipulation, or exclude privileged metadata forgery. No file descriptors are retained for a future execution. Immutable deployment and a fresh byte-to-execution binding therefore remain pending even after every hash matches. The trusted reader executable and harness installation are part of the controller trust boundary; an injected test executor is not evidence that native filesystem checks ran.

## What the receipt does and does not establish

`byteChecks` is `matched`, `mismatched` or `unavailable`. Source and individual input checks retain expected hashes, observed hashes and sizes where the entire bounded read succeeded. A read failure discards the partial combined observation. Matching bytes can still contain invalid JSON, incorrect scientific assertions or an unusable model; the verifier deliberately makes no semantic approval from those contents.

Every receipt leaves these checks pending: immutable deployment, execution-time freshness, source-revision authenticity, actual image contents, dependencies, trainer interpreter identity, model/tokenizer contents and native preflight. Initial-adapter plans also leave native adapter fingerprints pending. Resume plans additionally leave checkpoint tensors/native identity and the resume boundary pending. In particular, hashing checkpoint metadata does not establish tensor completeness, optimizer state, producer identity, or absence of a later reserved step. A future backend must refuse execution while its required checks remain pending; this module has no switch that promotes this receipt to launch authority.

Offline qualification uses only temporary fixtures. Tests cover binary and empty-directory inventory, executable-bit changes, hidden entries, exact receipt binding, mismatched bytes, unsupported native checks, symlink/hardlink refusal, missing files, traversal, bounds, caller mutation, cancellation, malformed helper output, FIFO refusal and a deterministic write during an actual reader operation. A fixture Python source raises if imported; it is hashed as data. No actual CoworkeRL artifact, trainer, provider or GPU stack has been qualified by these tests.
