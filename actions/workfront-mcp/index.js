/* eslint-disable jsdoc/require-jsdoc */
/*
 * App Builder action: workfront-mcp
 * MCP (JSON-RPC 2.0) server exposing Workfront document-linking tools.
 *
 * Methods: initialize, tools/list, tools/call
 *
 * Auth model: PASSTHROUGH. The orchestrator forwards the signed-in user's
 * exc_app IMS bearer token as `Authorization`. This action reads that header
 * and forwards the SAME token to both AEM and Workfront (Workfront calls AEM
 * on the user's behalf, so the token must be an exc_app user token).
 *
 * The primary tool creates a NATIVE AEM-linked document (same result as
 * "Add documents > AEM ... Author" in the Workfront UI), NOT an extdoc URL link.
 *
 * Deploy as a WEB action (web: 'yes', raw-http: true).
 */

const fetch = require('node-fetch')
const { authorize } = require('./auth')

const PROTOCOL_VERSION = '2024-11-05'
const DOC_OBJ_CODES = ['PROJ', 'TASK', 'OPTASK']

const TOOLS = [
  {
    name: 'workfront_link_aem_document',
    description: 'Link an AEM asset to a Workfront object (project/task/issue) as a NATIVE AEM-linked document, like "Add documents > AEM Author" in the UI. Resolves the asset UUID in AEM, builds the Workfront external storage handle, and creates the document via POST /document. Idempotent: if the asset is already linked, returns the existing document.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'aemHost', 'assetPath', 'docObjCode', 'objID', 'documentProviderID'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 255, description: 'Display name for the linked document.' },
        aemHost: { type: 'string', description: 'AEM author host, e.g. author-p1-e2.adobeaemcloud.com (no scheme).' },
        assetPath: { type: 'string', pattern: '^/content/dam/', description: 'DAM asset path, e.g. /content/dam/.../camp-alaska.jpg' },
        docObjCode: { type: 'string', enum: DOC_OBJ_CODES },
        objID: { type: 'string', pattern: '^[a-f0-9]{32}$' },
        documentProviderID: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Workfront AEM document provider ID.' },
        version: { type: 'string', pattern: '^\\d+\\.\\d+$', default: '20.0' }
      }
    }
  }
]

function rpcResult (id, result) { return { jsonrpc: '2.0', id, result } }
function rpcError (id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } } }
function validGuid (s) { return typeof s === 'string' && /^[a-f0-9]{32}$/.test(s) }
function validAssetPath (s) { return typeof s === 'string' && s.startsWith('/content/dam/') && !/\.\.|[?#\\]/.test(s) }

// node-fetch decompresses gzip responses transparently.
async function readBody (resp) {
  const text = await resp.text()
  try { return JSON.parse(text) } catch (e) { return { raw: text } }
}

function validateArgs (args, cfg) {
  const { name, aemHost, assetPath, docObjCode, objID, documentProviderID, version } = args
  if (typeof name !== 'string' || !name.trim() || name.length > 255) return 'name must be 1-255 characters.'
  if (!cfg.aemHosts.includes(String(aemHost).toLowerCase())) return `aemHost is not an allowed AEM author host (allowed: ${cfg.aemHosts.join(', ') || 'none configured'}).`
  if (!validAssetPath(assetPath)) return 'assetPath must be a DAM path starting with /content/dam/.'
  if (!DOC_OBJ_CODES.includes(docObjCode)) return `docObjCode must be one of ${DOC_OBJ_CODES.join(', ')}.`
  if (!validGuid(objID)) return 'objID must be a 32-char GUID.'
  if (!validGuid(documentProviderID)) return 'documentProviderID must be a 32-char GUID.'
  if (version !== undefined && !/^\d+\.\d+$/.test(version)) return 'version must look like 20.0.'
  return null
}

async function linkAemDocument (args, token, cfg) {
  const { name, assetPath, docObjCode, objID, documentProviderID } = args
  const aemHost = String(args.aemHost || '').toLowerCase()
  const version = args.version || cfg.version
  const wf = cfg.wfDomain

  if (!token) return { success: false, error: 'No user token forwarded; passthrough auth required.' }
  const invalid = validateArgs(args, cfg)
  if (invalid) return { success: false, statusCode: 400, error: invalid }

  const authHeader = { Authorization: `Bearer ${token}` }

  // Resolve asset UUID in AEM
  let uuid
  try {
    const r = await fetch(`https://${aemHost}${encodeURI(assetPath)}.json`, { headers: authHeader })
    if (r.status === 401 || r.status === 403) {
      return { success: false, statusCode: r.status, error: 'AEM rejected the token (not an AEM-trusted exc_app user token).' }
    }
    if (r.status === 404) return { success: false, statusCode: 404, error: `Asset not found in AEM: ${assetPath}` }
    const j = await readBody(r)
    uuid = j['jcr:uuid']
    if (!uuid) return { success: false, statusCode: r.status, error: 'Asset has no jcr:uuid (check path).' }
  } catch (e) {
    return { success: false, error: 'AEM request failed.' }
  }

  // Build external storage handle
  const handle = `urn:workfront:documents:aem:${aemHost}:${encodeURIComponent(`urn:aaid:aem:${uuid}`)}`

  // Return the existing document if this asset is already linked to the object
  try {
    const query = new URLSearchParams({ docObjCode, objID, fields: 'name,currentVersion:externalStorageID', $$LIMIT: '2000' })
    const r = await fetch(`${wf}/attask/api/v${version}/document/search?${query}`, { headers: authHeader })
    const j = await readBody(r)
    const rows = (r.ok && j && j.data) || []
    for (const d of rows) {
      const esid = d.currentVersion && d.currentVersion.externalStorageID
      if (esid === handle) {
        return { success: true, alreadyLinked: true, documentID: d.ID, name: d.name, externalStorageID: esid, documentURL: `${wf}/document/${d.ID}/overview` }
      }
    }
  } catch (e) { /* non-fatal: proceed to create */ }

  // Create the native AEM-linked document
  const updates = JSON.stringify({
    name,
    docObjCode,
    objID,
    externalIntegrationType: 'AEM',
    documentProviderID,
    handle
  })
  const form = new URLSearchParams()
  form.append('updates', updates)
  form.append('fields', 'name,currentVersion:externalStorageID,currentVersion:documentProviderID')

  try {
    const r = await fetch(`${wf}/attask/api/v${version}/document`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    })
    const j = await readBody(r)
    if (!r.ok) {
      let msg = (j && j.error && (j.error.message || j.error.msg)) || 'Workfront request failed.'
      if (r.status === 401 || r.status === 403) msg = 'Workfront authentication or permission problem.'
      if (r.status === 404) msg = `Workfront ${docObjCode} ${objID} not found.`
      if (r.status === 424) msg = `AEM rejected the forwarded token (needs exc_app user token): ${msg}`
      return { success: false, statusCode: r.status, error: msg }
    }
    const doc = (j && j.data) || {}
    const cv = doc.currentVersion || {}
    return {
      success: true,
      verified: cv.externalStorageID === handle && cv.documentProviderID === documentProviderID,
      documentID: doc.ID,
      name: doc.name,
      externalStorageID: cv.externalStorageID,
      documentProviderID: cv.documentProviderID,
      documentURL: doc.ID ? `${wf}/document/${doc.ID}/overview` : undefined
    }
  } catch (e) {
    return { success: false, error: 'Workfront request failed.' }
  }
}

async function main (params) {
  if (params.__ow_method && params.__ow_method.toLowerCase() !== 'post') {
    return { statusCode: 405, headers: { Allow: 'POST' }, body: '' }
  }

  const auth = await authorize(params)
  if (!auth.ok) {
    return { statusCode: auth.statusCode, headers: { 'Content-Type': 'application/json' }, body: rpcError(null, -32001, auth.message) }
  }

  const cfg = {
    wfDomain: (params.WF_DOMAIN || '').replace(/\/+$/, ''),
    version: params.WF_DEFAULT_VERSION || '20.0',
    aemHosts: String(params.AEM_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
  }

  // Forward the caller's token (passthrough); authorize() has already validated it.
  const token = params.__ow_headers.authorization.replace(/^Bearer\s+/i, '')

  let rpc = params.__ow_body
  if (typeof rpc === 'string') {
    try { rpc = JSON.parse(Buffer.from(rpc, 'base64').toString('utf8')) } catch (e) {
      try { rpc = JSON.parse(rpc) } catch (e2) { rpc = null }
    }
  }
  if (!rpc || !rpc.method) return { statusCode: 400, body: rpcError(null, -32600, 'Invalid MCP request') }

  const { id, method, params: p } = rpc
  if (id === undefined || method.startsWith('notifications/')) return { statusCode: 202, body: '' }

  let result
  if (method === 'initialize') {
    result = rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'workfront-aem-link-mcp', version: '2.0.0' } })
  } else if (method === 'tools/list') {
    result = rpcResult(id, { tools: TOOLS })
  } else if (method === 'tools/call') {
    const toolName = p && p.name
    const args = (p && p.arguments) || {}
    let toolResult
    if (!cfg.wfDomain) toolResult = { success: false, error: 'Server not configured: WF_DOMAIN missing.' }
    else if (toolName === 'workfront_link_aem_document') toolResult = await linkAemDocument(args, token, cfg)
    else toolResult = { success: false, error: `Unknown tool: ${toolName}` }
    result = rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(toolResult) }], isError: toolResult.success === false })
  } else {
    result = rpcError(id, -32601, `Method not found: ${method}`)
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: result }
}

exports.main = main
