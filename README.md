# Workfront AEM Asset Linker (MCP on Adobe App Builder)

An [MCP](https://modelcontextprotocol.io) server, deployed as an Adobe App Builder
(I/O Runtime) web action, that links AEM as a Cloud Service assets into Workfront
projects, tasks and issues as **native AEM-linked documents**. The result is the
same as **Add documents > AEM** in the Workfront UI, not a plain URL link.

It exposes one tool, `workfront_link_aem_document`, which AI agents (Adobe Agent
Orchestrator / Coworker, Cursor, or any MCP client) can call.

## How it works

```
MCP client ──(Bearer: user's exc_app IMS token)──▶ workfront-mcp action
                                                    │ 1. validate token with IMS + check org
                                                    │ 2. GET  <aem-author><asset>.json        → jcr:uuid
                                                    │ 3. GET  Workfront document/search       → already linked?
                                                    │ 4. POST Workfront /attask/api/v20.0/document
                                                    ▼        (externalIntegrationType: AEM)
                                            Workfront ──(same user token)──▶ AEM author
```

Authentication is **passthrough**: the action forwards the caller's own IMS token
to AEM and Workfront, so links are created as that user with that user's
permissions. No Workfront API key or service account is used.

> **The token must be an Experience Cloud user token (`client_id` = `exc_app`).**
> Workfront calls AEM with the token it receives, and AEM rejects tokens from the
> `aio` CLI or from OAuth server-to-server credentials.

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ and npm | The action runs on `nodejs:22` in Runtime. |
| Adobe I/O CLI | `npm install -g @adobe/aio-cli` |
| Adobe Developer Console access | With App Builder (I/O Runtime) entitlement in your org. |
| AEM as a Cloud Service author | Users who link assets need read access to the assets. |
| Workfront, connected to that AEM author | The native AEM integration must be set up (Workfront Setup > Documents > Experience Manager Integration), so **Add documents > AEM** works in the UI. |

## Setup in your Adobe org

### 1. Get the code

```bash
git clone https://github.com/LegoKam/attach-asset-collection-to-wf.git
cd attach-asset-collection-to-wf
npm install
```

### 2. Create an App Builder project

1. Open [Adobe Developer Console](https://developer.adobe.com/console) and select your org.
2. **Create project from template > App Builder**. Keep **Include Runtime with each workspace** checked.
3. Open the **Production** workspace (or Stage) and click **Download all** to get the
   workspace JSON, e.g. `MyProject-12345-Production.json`.

No APIs or credentials need to be added to the workspace; the action uses the caller's token.

### 3. Link the project with the aio CLI

```bash
aio login
cp .env.example .env
aio app use ~/Downloads/MyProject-12345-Production.json --merge
```

`aio app use` writes `.aio` and adds the `AIO_runtime_*` credentials to `.env`.
Alternatively select it interactively:

```bash
aio console org select
aio console project select
aio console workspace select
aio app use --merge
```

### 4. Fill in `.env`

Edit the values below in `.env` (leave the `AIO_*` entries written by `aio app use` as they are):

```bash
## IMS organization whose users may call the MCP server
ALLOWED_IMS_ORG_ID='ABCDEF0123456789@AdobeOrg'

## Adobe Workfront
WORKFRONT_API_URL='https://<instance>.my.workfront.adobe.com'
WORKFRONT_API_VERSION='20.0'

## AEM author hosts the action may forward user tokens to (comma-separated)
AEM_ALLOWED_HOSTS='author-p12345-e67890.adobeaemcloud.com'
```

| Variable | Where to find it |
|---|---|
| `ALLOWED_IMS_ORG_ID` | Developer Console project overview, or Admin Console > Settings. Ends in `@AdobeOrg`. |
| `WORKFRONT_API_URL` | The Workfront API origin, **not** the experience.adobe.com URL. In the Workfront UI, open DevTools > Network and look at the host of any `/attask/api-internal/...` request, e.g. `https://acme.my.workfront.adobe.com` or `https://acme-123.testdrive.workfront.adobe.com`. |
| `WORKFRONT_API_VERSION` | `20.0` (current); leave as is. |
| `AEM_ALLOWED_HOSTS` | The AEM author host(s) configured in Workfront's AEM integration, without `https://`. The action refuses any other host so user tokens can't be sent elsewhere. |

`.env` is git-ignored. Never commit it.

### 5. Deploy

```bash
npm test            # unit tests
aio app deploy
aio app get-url     # prints the MCP endpoint
```

The endpoint looks like:

```
https://<namespace>.adobeioruntime.net/api/v1/web/commerce-mcp-app/workfront-mcp
```

Quick check (expect `405` for GET and `401 Missing Bearer token.` for an unauthenticated POST):

```bash
MCP_URL=https://<namespace>.adobeioruntime.net/api/v1/web/commerce-mcp-app/workfront-mcp
curl -s -o /dev/null -w '%{http_code}\n' "$MCP_URL"
curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP_URL"
```

### 6. Get an Experience Cloud user token

Sign in to [experience.adobe.com](https://experience.adobe.com) in your org, open
DevTools > Console and run:

```js
adobeIMS.getAccessToken().token
```

The token lasts up to 24 hours. Treat it like a password. A Workfront session
JWT (`wf-auth` cookie) also works with the test scripts; they extract the IMS
token embedded in it.

### 7. Find the Workfront AEM document provider ID

The tool needs the 32-character ID of the Workfront document provider that points
at your AEM author. Workfront creates it the first time a user links from AEM:

1. In Workfront, open any project > **Documents > Add new > AEM (your integration name)** and link one asset.
2. Read the provider ID from that document:

```bash
export IMS_TOKEN='<token from step 6>'
WF=https://<instance>.my.workfront.adobe.com
PROJECT_ID=<32-char project ID from the project URL>

curl -s --compressed -G "$WF/attask/api/v20.0/document/search" \
  -H "Authorization: Bearer $IMS_TOKEN" \
  --data-urlencode docObjCode=PROJ \
  --data-urlencode "objID=$PROJECT_ID" \
  --data-urlencode 'fields=name,currentVersion:documentProviderID,currentVersion:externalStorageID'
```

Use the `documentProviderID` of the AEM-linked document (its `externalStorageID`
starts with `urn:workfront:documents:aem:`). It is not the integration's
configuration ID. Provider records can be per user; if another user gets a
provider error, have them link one asset from the UI once and repeat this step.

### 8. Test a link end to end

```bash
export IMS_TOKEN='<token from step 6>'
MCP_ENDPOINT="$MCP_URL" \
IMS_ORG_ID='ABCDEF0123456789@AdobeOrg' \
WORKFRONT_AEM_PROVIDER_ID='<provider ID from step 7>' \
./scripts/test-workfront-extdoc.sh \
  'https://author-p12345-e67890.adobeaemcloud.com/content/dam/path/to/asset.jpg' \
  '<32-char Workfront project ID>'
```

The script accepts a DAM path, an author URL, or an Assets UI
(`/ui#/aem/assetdetails.html/...`) URL, calls the MCP tool, and prints the
Workfront document URL. Running it again returns the existing document
instead of creating a duplicate. If `IMS_TOKEN` isn't set it prompts for it
(input hidden). Other options: `DOC_OBJ_CODE` (PROJ, TASK, OPTASK), `LINK_NAME`,
`AEM_AUTHOR_HOST` (used when you pass a bare DAM path).

`scripts/test-aem-link-passthrough.sh` performs the same AEM and Workfront calls
directly, without the MCP server, which helps tell server problems from token or
permission problems.

## Connect MCP clients

Every client must send two headers:

```
Authorization: Bearer <exc_app user IMS token>
x-gw-ims-org-id: <ALLOWED_IMS_ORG_ID>
```

### Cursor

Edit `.cursor/mcp.json`: set `url` to your endpoint and `x-gw-ims-org-id` to your
org. Then start Cursor with the token in its environment:

```bash
export WORKFRONT_MCP_IMS_TOKEN='<token from step 6>'
cursor .
```

Enable **workfront-mcp** under Cursor Settings > MCP. Restart with a fresh token when it expires.

### Adobe Agent Orchestrator / Coworker

Register the endpoint as a connector for your org. `mcp/agent-orchestrator-connector.json`
lists the values to enter (endpoint, streamable HTTP transport, user-token
passthrough auth, org header, tool schema); `mcp/server.json` is the same server in
the official MCP registry format. Update the URL, org ID, hosts and provider ID in
both files for your org. Choose the auth option that forwards the **signed-in
user's token**; a shared secret or service credential will fail at AEM.

## Tool reference: `workfront_link_aem_document`

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Document name in Workfront (1-255 characters). |
| `aemHost` | yes | AEM author host, e.g. `author-p12345-e67890.adobeaemcloud.com`. Must be in `AEM_ALLOWED_HOSTS`. |
| `assetPath` | yes | DAM path, e.g. `/content/dam/wknd/asset.jpg`. |
| `docObjCode` | yes | `PROJ` (project), `TASK` or `OPTASK` (issue). |
| `objID` | yes | 32-character Workfront object ID. |
| `documentProviderID` | yes | Workfront AEM document provider ID (step 7). |
| `version` | no | Workfront API version; defaults to `WORKFRONT_API_VERSION`. |

Example result:

```json
{
  "success": true,
  "verified": true,
  "documentID": "6af672a70004d53e15e1c045ccd9ad9e",
  "name": "fish",
  "externalStorageID": "urn:workfront:documents:aem:author-p12345-e67890.adobeaemcloud.com:urn%3Aaaid%3Aaem%3Afb9628be-...",
  "documentProviderID": "6af661ac000499833c1abe24889db97b",
  "documentURL": "https://<instance>.my.workfront.adobe.com/document/6af672a70004d53e15e1c045ccd9ad9e/overview"
}
```

If the asset is already linked to the object, the tool returns the existing
document with `"alreadyLinked": true`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 Missing Bearer token.` / `Invalid or missing x-gw-ims-org-id.` | Send both headers; the org must equal `ALLOWED_IMS_ORG_ID`. |
| `401 IMS access token is invalid or expired.` | Get a fresh token (step 6). |
| `403 Caller does not belong to the authorized IMS organization.` | The token's user isn't in `ALLOWED_IMS_ORG_ID`. |
| `AEM rejected the token (not an AEM-trusted exc_app user token)` | Token is from the `aio` CLI or a technical account, or the user lacks AEM access. Use an `exc_app` token from step 6. |
| `424 AEM rejected the forwarded token ...` | Workfront reached AEM but AEM refused the user. Check the user's AEM product profile and Workfront's AEM integration. |
| `aemHost is not an allowed AEM author host` | Add the host to `AEM_ALLOWED_HOSTS` and run `aio app deploy` again. |
| `Asset not found in AEM` | Check the DAM path (case-sensitive, includes the file extension). |
| `Workfront authentication or permission problem.` | The user can't add documents to that object, or `documentProviderID` belongs to someone else (step 7). |
| `Server not configured: WF_DOMAIN missing.` | `WORKFRONT_API_URL` was empty at deploy time; set it and redeploy. |
| `ERR1204 Workspace ... not found` after enabling `require-adobe-auth` | Leave `require-adobe-auth: false` in `app.config.yaml`; the action validates IMS tokens itself (`actions/workfront-mcp/auth.js`). |

Changes to `.env` only reach the action after `aio app deploy`.

## Project layout

```
actions/workfront-mcp/index.js   MCP server and the link tool
actions/workfront-mcp/auth.js    IMS token validation and org check
app.config.yaml                  Runtime action definition and inputs from .env
test/                            Jest unit tests
scripts/                         End-to-end test scripts
mcp/                             Registration descriptors
.cursor/mcp.json                 Cursor MCP client config
.env.example                     Template for .env
```

## Development commands

```bash
npm test                 # unit tests
npm run lint             # eslint
aio app deploy           # build and deploy the action
aio app get-url          # show the endpoint
aio app logs             # recent action logs
aio app undeploy         # remove the action from Runtime
```

## Security notes

- User tokens are forwarded only to the configured Workfront host and to hosts in `AEM_ALLOWED_HOSTS`.
- Tokens are never logged or returned in tool output.
- Every request is validated against IMS and restricted to `ALLOWED_IMS_ORG_ID`.
- Don't paste tokens into chats or commit them; they grant the user's access until they expire.
