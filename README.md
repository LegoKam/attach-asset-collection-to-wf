# Commerce MCP App

Adobe App Builder starter application configured to use the Adobe Commerce
Extensibility MCP server in Cursor.

## Setup

- Restart Cursor after cloning/opening this project so it loads
  `.cursor/mcp.json`.
- Authenticate with Adobe IMS using `aio auth login`.
- Select or import an App Builder workspace using `aio app use`.
- Populate the `.env` file in the project root and fill it as shown [below](#env)

The MCP server exposes Adobe I/O development, Commerce event subscription, and
Commerce documentation-search tools to Cursor.

### Workfront AEM-link MCP server

The `workfront-mcp` Runtime action is a stateless MCP Streamable HTTP endpoint
supporting `initialize`, `tools/list`, `tools/call` and notifications. It
exposes `workfront_link_aem_document`, which links an AEM asset to a Workfront
project, task or issue as a native AEM-linked document (the same result as
"Add documents > AEM" in the Workfront UI):

1. Resolves the asset's `jcr:uuid` from the AEM author.
2. Returns the existing document if the asset is already linked to the object.
3. Creates the document with `POST /attask/api/v{version}/document`
   (`externalIntegrationType: AEM`, the Workfront AEM `documentProviderID`, and
   the `urn:workfront:documents:aem:<host>:urn%3Aaaid%3Aaem%3A<uuid>` handle).

Authentication is passthrough: the caller's IMS token is validated (and must
belong to `ALLOWED_IMS_ORG_ID`), then forwarded to AEM and Workfront. Workfront
calls AEM on the user's behalf, so the token must be an Experience Cloud user
token (`client_id` `exc_app`); `aio auth login` and server-to-server tokens are
rejected by AEM. The token is only forwarded to hosts in `AEM_ALLOWED_HOSTS`
and to `WORKFRONT_API_URL`, both set in `.env`. No Workfront API key is used.

Test a deployed link end to end with:

```bash
IMS_TOKEN=<exc_app token> ./scripts/test-workfront-extdoc.sh [aem-asset-url-or-path] [workfront-object-guid]
```

Get the token from a signed-in experience.adobe.com tab with
`adobeIMS.getAccessToken().token`; a Workfront session JWT also works.

To use the server from Cursor, set `WORKFRONT_MCP_IMS_TOKEN` in Cursor's
environment; `.cursor/mcp.json` sends it as the bearer token.

## Local Dev

- `aio app run` to start your local Dev server
- App will run on `localhost:9080` by default

By default the UI will be served locally but actions will be deployed and served from Adobe I/O Runtime. To run your actions locally use the `aio app dev` option.

For more information on the difference between `aio app run` and `aio app dev`, see [here](https://developer.adobe.com/app-builder/docs/guides/development/#aio-app-dev-vs-aio-app-run)

## Test & Coverage

- Run `aio app test` (or `npm test`) to run the `workfront-mcp` unit tests

## Deploy & Cleanup

- `aio app deploy` to build and deploy the `workfront-mcp` action on Runtime
- `aio app undeploy` to undeploy the app

## Config

### `.env`

You can generate this file using the command `aio app use`. 

```bash
# This file must **not** be committed to source control

## please provide your Adobe I/O Runtime credentials
# AIO_RUNTIME_AUTH=
# AIO_RUNTIME_NAMESPACE=
```

### `app.config.yaml`

- Main configuration file that defines an application's implementation. 
- More information on this file, application configuration, and extension configuration 
  can be found [here](https://developer.adobe.com/app-builder/docs/guides/configuration/#appconfigyaml)

#### Action Dependencies

- You have two options to resolve your actions' dependencies:

  1. **Packaged action file**: Add your action's dependencies to the root
   `package.json` and install them using `npm install`. Then set the `function`
   field in `app.config.yaml` to point to the **entry file** of your action
   folder. We will use `webpack` to package your code and dependencies into a
   single minified js file. The action will then be deployed as a single file.
   Use this method if you want to reduce the size of your actions.

  2. **Zipped action folder**: In the folder containing the action code add a
     `package.json` with the action's dependencies. Then set the `function`
     field in `app.config.yaml` to point to the **folder** of that action. We will
     install the required dependencies within that directory and zip the folder
     before deploying it as a zipped action. Use this method if you want to keep
     your action's dependencies separated.

## Debugging in VS Code

While running your local server (`aio app dev`), both UI and actions can be debugged. To do so follow the instructions [here](https://developer.adobe.com/app-builder/docs/guides/development/#debugging)

## Typescript support for UI

To use typescript use `.tsx` extension for react components and add a `tsconfig.json` 
and make sure you have the below config added
```
 {
  "compilerOptions": {
      "jsx": "react"
    }
  } 
```
