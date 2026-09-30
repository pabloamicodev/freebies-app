/**
 * CI script: validate that every apps/shopify-admin/shopify.app*.toml is
 * internally consistent — i.e. all URL-shaped fields in a single store's
 * config point at the same hostname. Each new merchant store is a
 * copy-pasted shopify.app.<store>.toml, so a stray leftover URL from the
 * file it was copied from fails silently until a webhook or OAuth callback
 * breaks in production for that one store.
 *
 * Not a full TOML parser: this only extracts the handful of scalar/array
 * URL fields we care about via line scanning, since no TOML dependency is
 * installed anywhere in this monorepo (checked all package.json files).
 *
 * Exits non-zero if any file has a hostname mismatch, so this can be wired
 * into CI later.
 */

import { readFileSync } from "fs";
import { globSync } from "fs";
import { join } from "path";

const ROOT = join(process.cwd(), "apps/shopify-admin");

function findConfigFiles() {
  return globSync("shopify.app*.toml", { cwd: ROOT }).map((f) => join(ROOT, f));
}

/** Pulls out every field we consider "URL-shaped" from a shopify.app*.toml file. */
function extractFields(text) {
  const fields = {};

  const single = (name, re) => {
    const m = text.match(re);
    if (m) fields[name] = m[1];
  };

  single("client_id", /^client_id\s*=\s*"([^"]+)"/m);
  single("application_url", /^application_url\s*=\s*"([^"]+)"/m);
  single("app_proxy.url", /^\[app_proxy\][\s\S]*?^url\s*=\s*"([^"]+)"/m);
  single(
    "webhooks.privacy_compliance.customer_deletion_url",
    /^\[webhooks\.privacy_compliance\][\s\S]*?^customer_deletion_url\s*=\s*"([^"]+)"/m,
  );
  single(
    "webhooks.privacy_compliance.customer_data_request_url",
    /^\[webhooks\.privacy_compliance\][\s\S]*?^customer_data_request_url\s*=\s*"([^"]+)"/m,
  );
  single(
    "webhooks.privacy_compliance.shop_deletion_url",
    /^\[webhooks\.privacy_compliance\][\s\S]*?^shop_deletion_url\s*=\s*"([^"]+)"/m,
  );

  const redirectsMatch = text.match(/^redirect_urls\s*=\s*\[([\s\S]*?)\]/m);
  if (redirectsMatch) {
    const urls = [...redirectsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    urls.forEach((url, i) => {
      fields[`auth.redirect_urls[${i}]`] = url;
    });
  }

  return fields;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function checkFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  const fields = extractFields(text);

  const urlFields = Object.entries(fields).filter(([key]) => key !== "client_id");
  const hostnames = new Set();
  const byHostname = {};

  for (const [key, value] of urlFields) {
    const host = hostnameOf(value);
    if (!host) continue; // not a URL (shouldn't happen for the fields we extract)
    hostnames.add(host);
    (byHostname[host] ??= []).push(key);
  }

  const ok = hostnames.size <= 1;

  return {
    file: filePath,
    clientId: fields.client_id ?? null,
    urlFieldCount: urlFields.length,
    hostnames: [...hostnames],
    byHostname,
    ok,
  };
}

function main() {
  const files = findConfigFiles();

  if (files.length === 0) {
    console.error("❌ No shopify.app*.toml files found under apps/shopify-admin.");
    process.exit(1);
  }

  console.log("🛍️  Shopify app config consistency check\n");

  let failed = false;
  const results = [];

  for (const file of files) {
    const result = checkFile(file);
    results.push(result);

    const label = file.replace(process.cwd() + "\\", "").replace(process.cwd() + "/", "");

    if (result.ok) {
      console.log(`✅ ${label} — ${result.urlFieldCount} URL fields, single hostname (${result.hostnames[0]})`);
    } else {
      failed = true;
      console.log(`❌ ${label} — URL fields disagree on hostname:`);
      for (const [host, keys] of Object.entries(result.byHostname)) {
        console.log(`     ${host}:`);
        for (const key of keys) console.log(`       - ${key}`);
      }
    }
  }

  // Warn (non-fatal) on duplicate client_ids across files — almost always a
  // copy-paste mistake pointing two stores at the same Shopify app registration.
  const byClientId = {};
  for (const result of results) {
    if (!result.clientId) continue;
    (byClientId[result.clientId] ??= []).push(result.file);
  }
  const duplicates = Object.entries(byClientId).filter(([, files]) => files.length > 1);
  if (duplicates.length > 0) {
    console.log("\n⚠️  Duplicate client_id across files (likely copy-paste mistake):");
    for (const [clientId, files] of duplicates) {
      console.log(`   ${clientId}:`);
      for (const f of files) console.log(`     - ${f}`);
    }
  }

  console.log("");
  if (failed) {
    console.error("❌ One or more shopify.app*.toml files have internally inconsistent URLs.");
    process.exit(1);
  } else {
    console.log(`✅ All ${results.length} shopify.app*.toml files are internally consistent.`);
  }
}

main();
