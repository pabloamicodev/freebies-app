// Serve the real wizard and app-shell client code with deterministic loaders and
// actions. Shopify auth/providers are stubbed; catalog requests are mocked by the
// browser specs. No shop, database or deployment is changed by these tests.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");
const requireApp = createRequire(join(app, "package.json"));
const { build } = createRequire(requireApp.resolve("vite"))("esbuild");
const ts = requireApp("typescript");
const result = await build({
  stdin: {
    contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {createMemoryRouter, RouterProvider} from 'react-router';
      import Wizard from ${JSON.stringify(join(app, "app/routes/app.offers.new.codes.$template.tsx"))};
      import Shell from ${JSON.stringify(join(app, "app/routes/app.tsx"))};
      import NewOffer from ${JSON.stringify(join(app, "app/routes/app.offers.new._index.tsx"))};
      import ${JSON.stringify(join(app, "app/styles/bogos.css"))};
      const router = createMemoryRouter([{
        path: '/app', Component: Shell,
        loader: () => ({apiKey: 'test', graphqlConsoleEnabled: false}),
        children: [{
          path: 'offers/new/codes/:template', Component: Wizard,
          loader: () => ({nowLocal: '2026-10-02T10:00', currencyCode: 'USD'}),
          action: async () => {
            await new Promise(resolve => setTimeout(resolve, 400));
            return {error: 'Test validation error'};
          },
        }, {
          path: 'offers/new', Component: NewOffer,
          loader: ({request}) => ({shopDomain: 'hpn-test-store.myshopify.com', initialType: new URL(request.url).searchParams.get('type') ?? 'type'}),
        }, {path: 'offers/new/:type/:template', element: <h1>Wizard route</h1>},
        {path: 'offers', element: <h1>All offers</h1>}],
      }], {initialEntries: [window.location.pathname + window.location.search]});
      createRoot(document.getElementById('root')).render(<RouterProvider router={router}/>);
    `,
    loader: "tsx",
    resolveDir: app,
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  write: false,
  outfile: join(app, "app.js"),
  plugins: [{ name: "client-route-fixtures", setup(builder) {
    builder.onResolve({ filter: /^@shopify\/(polaris|shopify-app-react-router\/react|app-bridge-react)$/ }, args => ({ path: args.path, namespace: "fixture-provider" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-provider" }, () => ({ contents: "export const AppProvider=({children})=>children; export const NavMenu=()=>null;", loader: "js" }));
    builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "fixture-css" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-css" }, () => ({ contents: 'export default "";', loader: "js" }));
    builder.onLoad({ filter: /[\\/]routes[\\/](app\.offers\.new\.codes\..*|app\.offers\.new\._index|app)\.tsx$/ }, ({ path }) => {
      let contents = readFileSync(path, "utf8");
      const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      // Remove only server imports/exports, as the app build does. Keep the
      // original client functions, event handlers, hooks and components intact.
      for (const statement of [...source.statements].reverse()) {
        const isImport = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement);
        const module = isImport && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
        const serverImport = module.includes(".server.") || ["@promo/db", "@vercel/functions", "drizzle-orm", "@shopify/shopify-app-react-router/server"].includes(module) || module.endsWith("shopify-headers.js");
        const serverExport = ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ["loader", "action", "headers", "links"].includes(declaration.name.getText(source)));
        if (serverImport || serverExport) contents = contents.slice(0, statement.pos) + contents.slice(statement.end);
      }
      return { contents, loader: "tsx", resolveDir: join(app, "app/routes") };
    });
  } }],
});
const assets = new Map(result.outputFiles.map(file => [`/${basename(file.path)}`, file.contents]));
const html = '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
createServer((request, response) => {
  const asset = assets.get(request.url);
  response.setHeader("Content-Type", asset ? request.url.endsWith(".js") ? "text/javascript" : "text/css" : "text/html");
  response.end(asset ?? html);
}).listen(4192, "127.0.0.1");
