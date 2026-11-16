/*
* <license header>
*/

jest.mock('node-fetch')

const fetch = require('node-fetch')
const { authorize } = require('../actions/workfront-mcp/auth')

const ORG_ID = '523BF0605768FF0E7F000101@AdobeOrg'
const payload = Buffer.from(JSON.stringify({ client_id: 'aio-cli-console-auth' })).toString('base64url')
const token = `header.${payload}.signature`

/**
 * Builds action params carrying the given request headers.
 *
 * @param {object} headers request headers.
 * @returns {object} action params.
 */
function params (headers) {
  return { ALLOWED_IMS_ORG_ID: ORG_ID, __ow_headers: headers }
}

const validHeaders = { authorization: `Bearer ${token}`, 'x-gw-ims-org-id': ORG_ID }

/**
 * Creates a mocked JSON fetch response.
 *
 * @param {object} body response body.
 * @param {boolean} ok whether the response succeeded.
 * @returns {object} mocked response.
 */
function json (body, ok = true) {
  return { ok, json: jest.fn().mockResolvedValue(body) }
}

beforeEach(() => {
  fetch.mockReset()
})

describe('authorize', () => {
  test('accepts a valid token from a member of the allowed org', async () => {
    fetch
      .mockResolvedValueOnce(json({ valid: true }))
      .mockResolvedValueOnce(json([{ orgRef: { ident: '523BF0605768FF0E7F000101', authSrc: 'AdobeOrg' } }]))

    await expect(authorize(params(validHeaders))).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith(
      'https://ims-na1.adobelogin.com/ims/validate_token/v1',
      expect.objectContaining({ method: 'POST' })
    )
  })

  test('fails closed when the allowed org is not configured', async () => {
    const result = await authorize({ __ow_headers: validHeaders })
    expect(result).toEqual(expect.objectContaining({ ok: false, statusCode: 500 }))
  })

  test.each([
    [{}, 'Missing Bearer token.'],
    [{ authorization: `Bearer ${token}` }, 'Invalid or missing x-gw-ims-org-id.'],
    [{ authorization: `Bearer ${token}`, 'x-gw-ims-org-id': 'OTHER@AdobeOrg' }, 'Invalid or missing x-gw-ims-org-id.'],
    [{ authorization: 'Bearer not-a-jwt', 'x-gw-ims-org-id': ORG_ID }, 'Malformed IMS access token.']
  ])('rejects bad request headers without calling IMS', async (headers, message) => {
    const result = await authorize(params(headers))

    expect(fetch).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, statusCode: 401, message })
  })

  test('rejects tokens IMS reports as invalid', async () => {
    fetch.mockResolvedValueOnce(json({ valid: false }))

    const result = await authorize(params(validHeaders))
    expect(result).toEqual(expect.objectContaining({ ok: false, statusCode: 401 }))
  })

  test('rejects callers outside the allowed org', async () => {
    fetch
      .mockResolvedValueOnce(json({ valid: true }))
      .mockResolvedValueOnce(json([{ orgRef: { ident: 'SOMEONE_ELSE', authSrc: 'AdobeOrg' } }]))

    const result = await authorize(params(validHeaders))
    expect(result).toEqual(expect.objectContaining({ ok: false, statusCode: 403 }))
  })

  test('returns 503 when IMS is unreachable', async () => {
    fetch.mockRejectedValueOnce(new Error('network down'))

    const result = await authorize(params(validHeaders))
    expect(result).toEqual(expect.objectContaining({ ok: false, statusCode: 503 }))
  })
})
