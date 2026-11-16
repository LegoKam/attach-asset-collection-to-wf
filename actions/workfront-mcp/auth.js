/* eslint-disable jsdoc/require-jsdoc */
/*
 * Adobe IMS authorization for the workfront-mcp action.
 *
 * The platform `require-adobe-auth` validator cannot resolve this project's
 * workspace in the App Registry (ERR1204), so the action enforces the same
 * guarantees itself: a valid IMS access token whose user belongs to the
 * configured IMS organization.
 */

const fetch = require('node-fetch')

const IMS_HOST = 'https://ims-na1.adobelogin.com'

function unauthorized (message) {
  return { ok: false, statusCode: 401, message }
}

function readClientId (token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return typeof payload.client_id === 'string' ? payload.client_id : null
  } catch (error) {
    return null
  }
}

async function isValidToken (token, clientId) {
  const body = new URLSearchParams({ token, type: 'access_token', client_id: clientId })
  const response = await fetch(`${IMS_HOST}/ims/validate_token/v1`, { method: 'POST', body })
  if (!response.ok) return false
  const result = await response.json()
  return result.valid === true
}

async function belongsToOrg (token, imsOrgId) {
  const response = await fetch(`${IMS_HOST}/ims/organizations/v6`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!response.ok) return false
  const orgs = await response.json()
  return Array.isArray(orgs) &&
    orgs.some(org => `${org.orgRef?.ident}@${org.orgRef?.authSrc}` === imsOrgId)
}

async function authorize (params) {
  const allowedOrgId = params.ALLOWED_IMS_ORG_ID
  if (!allowedOrgId) {
    return { ok: false, statusCode: 500, message: 'Server not configured: ALLOWED_IMS_ORG_ID missing.' }
  }

  const headers = params.__ow_headers || {}
  const authorization = headers.authorization || ''
  if (!authorization.startsWith('Bearer ')) return unauthorized('Missing Bearer token.')
  if (headers['x-gw-ims-org-id'] !== allowedOrgId) return unauthorized('Invalid or missing x-gw-ims-org-id.')

  const token = authorization.substring('Bearer '.length)
  const clientId = readClientId(token)
  if (!clientId) return unauthorized('Malformed IMS access token.')

  try {
    if (!await isValidToken(token, clientId)) return unauthorized('IMS access token is invalid or expired.')
    if (!await belongsToOrg(token, allowedOrgId)) {
      return { ok: false, statusCode: 403, message: 'Caller does not belong to the authorized IMS organization.' }
    }
  } catch (error) {
    return { ok: false, statusCode: 503, message: 'Unable to validate the IMS access token.' }
  }

  return { ok: true }
}

module.exports = { authorize }
