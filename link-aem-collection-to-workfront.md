---
name: link-aem-collection-to-workfront
description: Automatically verifies an AEM collection, extracts its member assets, resolves the Workfront project and the true AEM documentProviderID (by name/host match on the documentProvider entity, never the doccfg_id) without user intervention, and links all assets as native AEM documents.
metadata:
  author: user
---

# Skill: Link AEM Collection Assets to Workfront Project

## Objective
Execute an end-to-end, zero-interruption workflow to link all assets from an Adobe Experience Manager (AEM) collection into a target Adobe Workfront project's Documents tab as native AEM-linked files.

## Provider ID cheat-sheet (read first — this is where past runs got stuck)

There are THREE different-looking IDs. Only one is the `documentProviderID`:

| ID | Where you see it | Use as `documentProviderID`? |
|---|---|---|
| `doccfg_id` | `approvals_list_aem_providers` | **NO** — it is the configuration record. Passing it fails with `Configuration.getConfigMapAsJson() ... config is null` (HTTP 500). Do not even test it. |
| `documentVersion_documentProviderID` | Existing AEM-linked document versions | Yes, but ONLY if the row's `externalStorageID` contains the exact target `{aemHost}`. Absent if that host was never linked. |
| **`ID` of the `documentProvider` record** | Workfront `documentProvider` entity, one record per registered integration (e.g. `AEM STE Author`) | **YES — the primary source.** Works even if the host has never been linked. |

**Absence of existing links for the host does NOT mean the handle is unresolvable.** Never ask the user to manually link an asset or supply the ID before completing the `documentProvider` lookup in Step 3.

## Core Execution Rules
1. **No guessing IDs:** Never use `doccfg_id` or a handle taken from a different host's documents.
2. **Source of truth:** the `ID` of the Workfront `documentProvider` record whose name/host matches `{aemHost}`.
3. **Per integration, not per org:** One Workfront instance can hold several providers (e.g. `AEM 256`, `AEM STE Author`). Match the one for the target `{aemHost}`.
4. **Fail-fast validation:** Verify collection accessibility and project existence before linking.
5. **Autonomous resolution:** Extract all parameters from the input URLs and API queries. Only pause to ask the user if the collection is empty/inaccessible (401/403/404), or if, after the full Step 3 procedure, no provider can be matched to `{aemHost}`.
6. **Linking is idempotent** (already-linked assets return the existing document), so parallel execution is safe after the first-asset check.
7. **Don't burn calls on dead ends.** Do NOT: loop through `insights_find_workfront_data` on `documentVersion` hoping to find a handle for a never-linked host; call `approvals_list_aem_linked_folders` for the handle; or test-link with the `doccfg_id`.

## Step-by-Step Workflow

### Step 1: Parse Inputs
- **AEM Host:** e.g. `author-p152232-e2390229.adobeaemcloud.com` (strip `https://` and trailing slashes).
- **AEM Collection Path:** the `/content/dam/collections/...` path from the UI URL (strip the `/ui#/aem/mnt/overlay/dam/gui/content/collections/collectiondetails.html` prefix).
- **Workfront Project ID (`objID`):** the 32-char hex after `/project/` in the Workfront URL.

### Step 2: Verify Collection & Fetch Assets
1. `GET https://{aemHost}{collectionPath}.infinity.json`
2. `401`/`403` → stop, tell user they lack permission. `404` → stop, verify path.
3. Parse `body["sling:members"]["sling:resources"]` (array of `/content/dam/...` paths). Empty/missing → stop and notify the user.

### Step 3: Resolve `documentProviderID` for THIS `{aemHost}`

**3a. Primary — query the `documentProvider` entity (do this first):**
1. Use the Workfront MCP insights tools: call `insights_list_entities` to confirm the document-provider entity name on this surface (look for `documentProvider` / `DOCPRV`), and `insights-schema_search_workfront_schema` with a query like "document provider" if needed to get its field names.
2. Call `insights_find_workfront_data` on that entity, projecting its `ID` and `name` (add any host/repo field the schema exposes). Fetch all records.
3. Select the record whose `name` matches the target integration (e.g. `"AEM STE Author"` for `author-p152232-e2390229.adobeaemcloud.com`). Its `ID` is the `documentProviderID`.
4. Mapping provider name → host: call `approvals_list_aem_providers`. Each entry has a name and an `aemRepoId` containing the host. Find the entry whose `aemRepoId` contains `{aemHost}`, take its **name**, and match that name to the `documentProvider` record. (Use that call ONLY for the name↔host mapping; ignore its `doccfg_id`.)
5. If exactly one AEM `documentProvider` exists, use it. If several exist and the name still does not disambiguate, ask the user which one.

**3b. Fallback / confirmation — host-matched existing document version:**
Query `documentVersion` where `documentProviderID` is not null, projecting `documentProviderID` and `externalStorageID` (`urn:workfront:documents:aem:{aemHost}:urn%3Aaaid%3Aaem%3A<uuid>`). Take the handle only from a row whose `externalStorageID` contains the exact `{aemHost}`. If none exists, this host is unlinked — rely on 3a.

**3c. Validation:** the ID must match `^[a-f0-9]{32}$` and must NOT equal any `doccfg_id`.

**Stop condition:** only if 3a returns no matching provider AND 3b has no host-matched row, tell the user the integration isn't registered/visible and ask them to confirm the provider name or supply the 32-hex ID. Manual UI linking is a last resort, not a first response.

### Step 4: Verify Target Project & Existing Documents
1. Fetch the project (`PROJ`) by `objID`; confirm it exists.
2. Query existing documents on the project to flag assets already linked.

### Step 5: Link Assets
For each asset path from Step 2, call `wf-mcp__workfront_link_aem_document` with:
- `aemHost`: `{aemHost}`
- `assetPath`: `{asset_dam_path}`
- `name`: filename from the end of `assetPath` (stored display name may drop the extension)
- `docObjCode`: `"PROJ"` (enum `PROJ | TASK | OPTASK`; use `OPTASK` for issues, never `ISSUE`)
- `objID`: `{projectID}`
- `documentProviderID`: the Step 3 handle

**First-asset sanity check:** link ONE asset first. Confirm `success: true`, the echoed `documentProviderID` equals the one sent, and the returned `externalStorageID` contains `{aemHost}`. Then link the rest in parallel.

### Step 6: Final Verification & Output
1. Confirm each response has `success: true` / `verified: true`, or re-query project documents.
2. Present a concise table: asset name, DAM path, status (`Linked` / `Already Linked` / `Failed` + reason).
3. If the user asks how the provider ID was found, explain: `doccfg_id` is the config record (decoy); the real handle is the `documentProvider` record's own `ID`, matched by provider name/host, then confirmed by the first link echoing the same ID with an `externalStorageID` on the target host.
