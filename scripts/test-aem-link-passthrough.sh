#!/usr/bin/env bash
# Verifies that a caller's Experience Cloud IMS token can link an AEM asset to a
# Workfront object through the public Workfront API (no Workfront API key).
#
# Get a token from a signed-in experience.adobe.com tab (DevTools console):
#   adobeIMS.getAccessToken().token
#
# Usage: scripts/test-aem-link-passthrough.sh [ASSET_PATH] [OBJECT_ID]
set -euo pipefail

WF_HOST="${WORKFRONT_API_URL:-https://ags489-06032401.testdrive.workfront.adobe.com}"
WF_VERSION="${WORKFRONT_API_VERSION:-20.0}"
AEM_HOST="${AEM_AUTHOR_HOST:-author-p152232-e2390229.adobeaemcloud.com}"
DOCUMENT_PROVIDER_ID="${WORKFRONT_AEM_PROVIDER_ID:-6af661ac000499833c1abe24889db97b}"
ASSET_PATH="${1:-/content/dam/wknd-shared/en/magazine/alaska-adventure/bear-path.jpg}"
OBJECT_ID="${2:-6ab9a95b001737ba193f8229f9b7c105}"
DOC_OBJ_CODE="${DOC_OBJ_CODE:-PROJ}"

if [[ -z "${IMS_TOKEN:-}" ]]; then
  read -r -s -p "Paste IMS access token (input hidden): " IMS_TOKEN
  echo
fi

echo "1) Resolving asset UUID in AEM: $ASSET_PATH"
asset_json="$(curl -sS --compressed -w '\n%{http_code}' \
  -H "Authorization: Bearer $IMS_TOKEN" \
  "https://$AEM_HOST${ASSET_PATH}.json")"
asset_status="${asset_json##*$'\n'}"
asset_body="${asset_json%$'\n'*}"
if [[ "$asset_status" != "200" ]]; then
  echo "   AEM returned HTTP $asset_status; this token is not accepted by AEM author." >&2
  exit 1
fi
asset_uuid="$(node -e 'const j=JSON.parse(process.argv[1]);if(!j["jcr:uuid"])process.exit(1);console.log(j["jcr:uuid"])' "$asset_body")" || {
  echo "   No jcr:uuid on $ASSET_PATH." >&2
  exit 1
}
echo "   UUID: $asset_uuid"

asset_name="$(basename "$ASSET_PATH")"
storage_id="urn:workfront:documents:aem:${AEM_HOST}:$(node -e 'console.log(encodeURIComponent("urn:aaid:aem:"+process.argv[1]))' "$asset_uuid")"
updates="$(node -e '
const [name, objCode, objID, providerID, handle] = process.argv.slice(1)
console.log(JSON.stringify({ name, docObjCode: objCode, objID, externalIntegrationType: "AEM", documentProviderID: providerID, handle }))
' "${asset_name%.*}" "$DOC_OBJ_CODE" "$OBJECT_ID" "$DOCUMENT_PROVIDER_ID" "$storage_id")"

echo "2) Creating AEM-linked document on $DOC_OBJ_CODE $OBJECT_ID"
result="$(curl -sS --compressed -w '\n%{http_code}' -X POST \
  -H "Authorization: Bearer $IMS_TOKEN" \
  --data-urlencode "updates=$updates" \
  --data-urlencode 'fields=name,currentVersion:externalStorageID,currentVersion:documentProviderID' \
  "$WF_HOST/attask/api/v${WF_VERSION}/document")"
status="${result##*$'\n'}"
body="${result%$'\n'*}"
echo "   HTTP $status"
echo "   $body" | head -c 800
echo
if [[ "$status" == "200" ]]; then
  doc_id="$(node -e 'console.log(JSON.parse(process.argv[1]).data.ID)' "$body")"
  echo "   Linked: $WF_HOST/document/$doc_id/overview"
fi
