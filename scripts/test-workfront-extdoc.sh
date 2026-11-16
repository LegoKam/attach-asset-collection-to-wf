#!/usr/bin/env bash
# Links an AEM asset to a Workfront object through the deployed workfront-mcp
# action (MCP tools/call -> workfront_link_aem_document).
#
# The action forwards the caller's token to AEM and Workfront, so it must be an
# Experience Cloud user token (client_id exc_app). Tokens from `aio auth login`
# are rejected by AEM. Get one from a signed-in experience.adobe.com tab with
#   adobeIMS.getAccessToken().token
# A Workfront session JWT also works; its embedded IMS token is used.

set -euo pipefail

DEFAULT_ENDPOINT='https://31876-766magentabandicoot.adobeioruntime.net/api/v1/web/commerce-mcp-app/workfront-mcp'
DEFAULT_IMS_ORG_ID='523BF0605768FF0E7F000101@AdobeOrg'
DEFAULT_ASSET='https://author-p152232-e2390229.adobeaemcloud.com/content/dam/wknd-shared/en/magazine/alaska-adventure/camp-alaska.jpg'

MCP_ENDPOINT="${MCP_ENDPOINT:-$DEFAULT_ENDPOINT}"
IMS_ORG_ID="${IMS_ORG_ID:-$DEFAULT_IMS_ORG_ID}"
ASSET="${1:-${ASSET_URL:-$DEFAULT_ASSET}}"
OBJECT_ID="${2:-${WORKFRONT_OBJECT_ID:-6ab9a95b001737ba193f8229f9b7c105}}"
DOC_OBJ_CODE="${DOC_OBJ_CODE:-PROJ}"
DOCUMENT_PROVIDER_ID="${WORKFRONT_AEM_PROVIDER_ID:-6af661ac000499833c1abe24889db97b}"
AEM_HOST="${AEM_AUTHOR_HOST:-author-p152232-e2390229.adobeaemcloud.com}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/test-workfront-extdoc.sh [aem-asset-url-or-path] [workfront-object-guid]

The asset may be a DAM path, an author URL, or an Assets UI (#/aem/assetdetails.html) URL.

Optional environment variables:
  IMS_TOKEN                  exc_app user token or Workfront session JWT (prompted if unset)
  LINK_NAME                  Display name in Workfront (default: file name without extension)
  DOC_OBJ_CODE               PROJ, TASK, or OPTASK (default: PROJ)
  WORKFRONT_AEM_PROVIDER_ID  Workfront AEM document provider ID
  AEM_AUTHOR_HOST            Used when the asset is given as a bare DAM path
  MCP_ENDPOINT               Deployed workfront-mcp action URL
  IMS_ORG_ID                 Adobe IMS organization ID
EOF
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { usage; exit 0; }

for command_name in curl node; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Error: required command '$command_name' was not found." >&2; exit 127; }
done

read -r AEM_HOST ASSET_PATH < <(node - "$ASSET" "$AEM_HOST" <<'NODE'
const [input, fallbackHost] = process.argv.slice(2)
if (input.startsWith('/content/dam/')) { console.log(fallbackHost, input); process.exit(0) }
const url = new URL(input)
const assetPath = (url.hash.match(/\/content\/dam\/[^?]*/) || url.pathname.match(/\/content\/dam\/.*/) || [])[0]
if (!assetPath) { console.error('Error: could not find a /content/dam/ path in the asset URL.'); process.exit(1) }
console.log(url.host, decodeURI(assetPath))
NODE
)

if [[ ! "$OBJECT_ID" =~ ^[a-f0-9]{32}$ ]]; then
  echo 'Error: Workfront object ID must be 32 lowercase hexadecimal characters.' >&2
  exit 2
fi
if [[ ! "$DOC_OBJ_CODE" =~ ^(PROJ|TASK|OPTASK)$ ]]; then
  echo 'Error: DOC_OBJ_CODE must be PROJ, TASK, or OPTASK.' >&2
  exit 2
fi

if [[ -z "${IMS_TOKEN:-}" ]]; then
  read -r -s -p 'Paste exc_app IMS access token (input hidden): ' IMS_TOKEN
  echo
fi
IMS_TOKEN="$(node -e '
const t = process.argv[1].replace(/^Bearer\s+/i, "")
try {
  const p = JSON.parse(Buffer.from(t.split(".")[1], "base64url"))
  console.log(p.workfront && p.workfront.ims_jwt ? p.workfront.ims_jwt : t)
} catch (e) { console.log(t) }' "$IMS_TOKEN")"

ASSET_FILE="${ASSET_PATH##*/}"
LINK_NAME="${LINK_NAME:-${ASSET_FILE%.*}}"

PAYLOAD="$(
  node - "$LINK_NAME" "$AEM_HOST" "$ASSET_PATH" "$DOC_OBJ_CODE" "$OBJECT_ID" "$DOCUMENT_PROVIDER_ID" <<'NODE'
const [name, aemHost, assetPath, docObjCode, objID, documentProviderID] = process.argv.slice(2)
process.stdout.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'workfront_link_aem_document',
    arguments: { name, aemHost, assetPath, docObjCode, objID, documentProviderID }
  }
}))
NODE
)"

RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

echo "Linking $AEM_HOST$ASSET_PATH to Workfront $DOC_OBJ_CODE $OBJECT_ID as '$LINK_NAME'..."

HTTP_STATUS="$(
  curl --silent --show-error \
    --output "$RESPONSE_FILE" \
    --write-out '%{http_code}' \
    --request POST "$MCP_ENDPOINT" \
    --header 'Content-Type: application/json' \
    --header 'Accept: application/json' \
    --header "Authorization: Bearer $IMS_TOKEN" \
    --header "x-gw-ims-org-id: $IMS_ORG_ID" \
    --data "$PAYLOAD"
)"

if [[ ! "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]]; then
  echo "MCP endpoint returned HTTP $HTTP_STATUS:" >&2
  cat "$RESPONSE_FILE" >&2
  echo >&2
  exit 1
fi

node - "$RESPONSE_FILE" <<'NODE'
const fs = require('fs')

let rpc
try {
  rpc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
} catch (error) {
  console.error('Error: MCP endpoint did not return valid JSON.')
  process.exit(1)
}

if (rpc.error) {
  console.error(`MCP error ${rpc.error.code}: ${rpc.error.message}`)
  process.exit(1)
}

const text = rpc.result?.content?.find(item => item.type === 'text')?.text
let result
try {
  result = JSON.parse(text)
} catch (error) {
  console.error(`Error: MCP tool returned an unexpected result: ${text}`)
  process.exit(1)
}

if (!result.success) {
  console.error(`Link failed: ${result.error || 'Unknown error'}`)
  if (result.statusCode) console.error(`Status: ${result.statusCode}`)
  process.exit(1)
}

console.log(result.alreadyLinked ? 'Asset was already linked; existing document returned.' : 'AEM-linked document created.')
console.log(`Document ID:        ${result.documentID}`)
console.log(`Document URL:       ${result.documentURL}`)
console.log(`External storage:   ${result.externalStorageID}`)
if (result.verified === false) console.log('Warning: Workfront stored a different storage ID or provider than requested.')
NODE
