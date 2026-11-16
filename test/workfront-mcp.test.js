/*
* <license header>
*/

jest.mock('node-fetch')
jest.mock('../actions/workfront-mcp/auth', () => ({
  authorize: jest.fn()
}))

const fetch = require('node-fetch')
const { authorize } = require('../actions/workfront-mcp/auth')
const action = require('../actions/workfront-mcp')

const WF = 'https://example.testdrive.workfront.adobe.com'
const AEM_HOST = 'author-p1-e2.adobeaemcloud.com'
const UUID = 'fb9628be-8c23-4e1b-a4ed-78fc1361e50d'
const HANDLE = `urn:workfront:documents:aem:${AEM_HOST}:urn%3Aaaid%3Aaem%3A${UUID}`
const PROVIDER_ID = '6af661ac000499833c1abe24889db97b'
const OBJ_ID = '6ab9a95b001737ba193f8229f9b7c105'

const config = {
  WF_DOMAIN: `${WF}/`,
  WF_DEFAULT_VERSION: '20.0',
  AEM_ALLOWED_HOSTS: `${AEM_HOST}, other-author.adobeaemcloud.com`,
  __ow_headers: { authorization: 'Bearer user-token' }
}

const validArguments = {
  name: 'fish',
  aemHost: AEM_HOST,
  assetPath: '/content/dam/wknd-shared/en/magazine/alaska-adventure/fish.jpg',
  docObjCode: 'PROJ',
  objID: OBJ_ID,
  documentProviderID: PROVIDER_ID
}

/**
 * Sends a base64-encoded JSON-RPC message in the App Builder raw-http body format.
 *
 * @param {object} rpc JSON-RPC message.
 * @param {object} extra extra action params.
 * @returns {Promise<object>} action response.
 */
function send (rpc, extra = {}) {
  return action.main({
    ...config,
    ...extra,
    __ow_method: 'post',
    __ow_body: Buffer.from(JSON.stringify(rpc)).toString('base64')
  })
}

/**
 * Calls the link tool.
 *
 * @param {object} args tool arguments.
 * @param {object} extra extra action params.
 * @returns {Promise<object>} action response.
 */
function callLink (args = validArguments, extra) {
  return send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workfront_link_aem_document', arguments: args } }, extra)
}

/**
 * Reads structured data from an MCP text-content result.
 *
 * @param {object} response action response.
 * @returns {object} parsed tool result.
 */
function toolOutput (response) {
  return JSON.parse(response.body.result.content[0].text)
}

/**
 * Creates a mocked fetch response.
 *
 * @param {number} status HTTP status.
 * @param {object} body response body.
 * @returns {object} mocked response.
 */
function reply (status, body = {}) {
  return { ok: status >= 200 && status < 300, status, text: jest.fn().mockResolvedValue(JSON.stringify(body)) }
}

const aemAsset = () => reply(200, { 'jcr:primaryType': 'dam:Asset', 'jcr:uuid': UUID })
const noExistingDocs = () => reply(200, { data: [] })

beforeEach(() => {
  fetch.mockReset()
  authorize.mockReset()
  authorize.mockResolvedValue({ ok: true })
})

describe('MCP transport', () => {
  test('rejects unauthorized callers before handling the request', async () => {
    authorize.mockResolvedValue({ ok: false, statusCode: 401, message: 'Missing Bearer token.' })

    const response = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    expect(fetch).not.toHaveBeenCalled()
    expect(response.statusCode).toBe(401)
    expect(response.body.error).toEqual({ code: -32001, message: 'Missing Bearer token.' })
  })

  test('rejects non-POST requests so clients skip the SSE stream', async () => {
    const response = await action.main({ ...config, __ow_method: 'get' })

    expect(response).toEqual({ statusCode: 405, headers: { Allow: 'POST' }, body: '' })
    expect(authorize).not.toHaveBeenCalled()
  })

  test('acknowledges notifications without a response body', async () => {
    const response = await send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    expect(response).toEqual({ statusCode: 202, body: '' })
  })

  test('negotiates the MCP protocol version', async () => {
    const response = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })

    expect(response.statusCode).toBe(200)
    expect(response.body.result).toEqual({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'workfront-aem-link-mcp', version: '2.0.0' }
    })
  })

  test('lists the AEM link tool', async () => {
    const response = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = response.body.result.tools

    expect(tools.map(tool => tool.name)).toEqual(['workfront_link_aem_document'])
    expect(tools[0].inputSchema.required).toEqual(['name', 'aemHost', 'assetPath', 'docObjCode', 'objID', 'documentProviderID'])
  })

  test('rejects invalid MCP bodies', async () => {
    const response = await action.main({ ...config, __ow_body: 'not-json' })

    expect(response).toEqual({ statusCode: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid MCP request' } } })
  })

  test('reports unknown methods', async () => {
    const response = await send({ jsonrpc: '2.0', id: 7, method: 'resources/list' })

    expect(response.body.error).toEqual({ code: -32601, message: 'Method not found: resources/list' })
  })
})

describe('workfront_link_aem_document', () => {
  test('resolves the AEM UUID and creates a native AEM-linked document with the caller token', async () => {
    fetch
      .mockResolvedValueOnce(aemAsset())
      .mockResolvedValueOnce(noExistingDocs())
      .mockResolvedValueOnce(reply(200, {
        data: { ID: 'doc1', name: 'fish', currentVersion: { externalStorageID: HANDLE, documentProviderID: PROVIDER_ID } }
      }))

    const response = await callLink()

    const [aemUrl, aemOptions] = fetch.mock.calls[0]
    expect(aemUrl).toBe(`https://${AEM_HOST}/content/dam/wknd-shared/en/magazine/alaska-adventure/fish.jpg.json`)
    expect(aemOptions.headers.Authorization).toBe('Bearer user-token')

    const searchUrl = new URL(fetch.mock.calls[1][0])
    expect(searchUrl.pathname).toBe('/attask/api/v20.0/document/search')
    expect(searchUrl.searchParams.get('objID')).toBe(OBJ_ID)

    const [createUrl, createOptions] = fetch.mock.calls[2]
    expect(createUrl).toBe(`${WF}/attask/api/v20.0/document`)
    expect(createOptions.method).toBe('POST')
    expect(createOptions.headers.Authorization).toBe('Bearer user-token')
    expect(JSON.parse(new URLSearchParams(createOptions.body).get('updates'))).toEqual({
      name: 'fish',
      docObjCode: 'PROJ',
      objID: OBJ_ID,
      externalIntegrationType: 'AEM',
      documentProviderID: PROVIDER_ID,
      handle: HANDLE
    })

    expect(response.body.result.isError).toBe(false)
    expect(toolOutput(response)).toEqual({
      success: true,
      verified: true,
      documentID: 'doc1',
      name: 'fish',
      externalStorageID: HANDLE,
      documentProviderID: PROVIDER_ID,
      documentURL: `${WF}/document/doc1/overview`
    })
  })

  test('returns the existing document instead of linking the same asset twice', async () => {
    fetch
      .mockResolvedValueOnce(aemAsset())
      .mockResolvedValueOnce(reply(200, { data: [{ ID: 'old', name: 'fish', currentVersion: { externalStorageID: HANDLE } }] }))

    const response = await callLink()

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(toolOutput(response)).toEqual(expect.objectContaining({ success: true, alreadyLinked: true, documentID: 'old' }))
  })

  test('still creates the link when the duplicate search fails', async () => {
    fetch
      .mockResolvedValueOnce(aemAsset())
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(reply(200, { data: { ID: 'doc2', name: 'fish', currentVersion: { externalStorageID: HANDLE, documentProviderID: PROVIDER_ID } } }))

    expect(toolOutput(await callLink())).toEqual(expect.objectContaining({ success: true, documentID: 'doc2' }))
  })

  test.each([
    ['an AEM host that is not allowlisted', { aemHost: 'attacker.example.com' }, 'aemHost is not an allowed AEM author host'],
    ['a path outside the DAM', { assetPath: '/etc/passwd' }, 'assetPath must be a DAM path'],
    ['a path traversal', { assetPath: '/content/dam/../../etc' }, 'assetPath must be a DAM path'],
    ['an unsupported object code', { docObjCode: 'USER' }, 'docObjCode must be one of'],
    ['a malformed object ID', { objID: 'abc' }, 'objID must be a 32-char GUID.'],
    ['a malformed provider ID', { documentProviderID: 'abc' }, 'documentProviderID must be a 32-char GUID.'],
    ['a malformed API version', { version: '20.0/../x' }, 'version must look like 20.0.'],
    ['an empty name', { name: ' ' }, 'name must be 1-255 characters.']
  ])('rejects %s without forwarding the token', async (label, override, message) => {
    const result = toolOutput(await callLink({ ...validArguments, ...override }))

    expect(fetch).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(400)
    expect(result.error).toContain(message)
  })

  test.each([401, 403])('maps AEM %i to a token message', async status => {
    fetch.mockResolvedValueOnce(reply(status))

    const result = toolOutput(await callLink())

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: false, statusCode: status, error: 'AEM rejected the token (not an AEM-trusted exc_app user token).' })
  })

  test('reports a missing AEM asset', async () => {
    fetch.mockResolvedValueOnce(reply(404))

    expect(toolOutput(await callLink())).toEqual({ success: false, statusCode: 404, error: `Asset not found in AEM: ${validArguments.assetPath}` })
  })

  test.each([
    [403, { error: { message: 'Authorization is required.' } }, 'Workfront authentication or permission problem.'],
    [404, { error: { message: 'not found' } }, `Workfront PROJ ${OBJ_ID} not found.`],
    [424, { error: { message: 'There was a problem with External Document.' } }, 'AEM rejected the forwarded token (needs exc_app user token): There was a problem with External Document.'],
    [422, { error: { message: 'Invalid handle' } }, 'Invalid handle']
  ])('maps Workfront %i on create', async (status, body, message) => {
    fetch
      .mockResolvedValueOnce(aemAsset())
      .mockResolvedValueOnce(noExistingDocs())
      .mockResolvedValueOnce(reply(status, body))

    expect(toolOutput(await callLink())).toEqual({ success: false, statusCode: status, error: message })
  })

  test('does not leak network error details', async () => {
    fetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND author-p1-e2.adobeaemcloud.com token=user-token'))

    const response = await callLink()

    expect(response.body.result.content[0].text).not.toContain('user-token')
    expect(toolOutput(response)).toEqual({ success: false, error: 'AEM request failed.' })
  })

  test('reports missing server configuration', async () => {
    const result = toolOutput(await callLink(validArguments, { WF_DOMAIN: '' }))

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toEqual({ success: false, error: 'Server not configured: WF_DOMAIN missing.' })
  })

  test('reports unknown tools', async () => {
    const response = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } })

    expect(response.body.result.isError).toBe(true)
    expect(toolOutput(response)).toEqual({ success: false, error: 'Unknown tool: nope' })
  })
})
