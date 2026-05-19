/**
 * Migrate documents from local Elasticsearch to Elastic Cloud.
 *
 * Usage:
 *   ELASTICSEARCH_URL=https://... ELASTICSEARCH_API_KEY=... npx tsx scripts/migrate-to-cloud.ts
 */

const LOCAL_ES = "http://localhost:9200";
const INDEX = "nvidia-blogs";
const BATCH_SIZE = 500;

const remoteUrl = process.env.ELASTICSEARCH_URL;
const apiKey = process.env.ELASTICSEARCH_API_KEY;

if (!remoteUrl || !apiKey) {
  console.error(
    "Missing ELASTICSEARCH_URL or ELASTICSEARCH_API_KEY env vars.\n" +
      "Usage: ELASTICSEARCH_URL=https://... ELASTICSEARCH_API_KEY=... npx tsx scripts/migrate-to-cloud.ts"
  );
  process.exit(1);
}

async function fetchJson(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function run() {
  // 1. Get mapping from local and create index on remote
  console.log(`Reading mapping from ${LOCAL_ES}/${INDEX}...`);
  const mapping = await fetchJson(`${LOCAL_ES}/${INDEX}`);
  const indexSettings = mapping[INDEX];

  // Create index on remote (ignore if exists)
  const createBody = {
    mappings: indexSettings.mappings,
  };

  const createRes = await fetch(`${remoteUrl}/${INDEX}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${apiKey}`,
    },
    body: JSON.stringify(createBody),
  });

  if (createRes.status === 400) {
    const err = await createRes.json();
    if (err.error?.type === "resource_already_exists_exception") {
      console.log("Index already exists on remote, continuing...");
    } else {
      throw new Error(`Failed to create index: ${JSON.stringify(err)}`);
    }
  } else if (!createRes.ok) {
    throw new Error(`Failed to create index: ${createRes.status}`);
  } else {
    console.log("Created index on remote.");
  }

  // 2. Scroll through local docs and bulk index to remote
  let scrollId: string | null = null;
  let total = 0;

  // Initial search
  const initRes = await fetchJson(
    `${LOCAL_ES}/${INDEX}/_search?scroll=2m&size=${BATCH_SIZE}`
  );
  scrollId = initRes._scroll_id;
  let hits = initRes.hits.hits;

  while (hits.length > 0) {
    // Build bulk body
    const bulkLines: string[] = [];
    for (const hit of hits) {
      bulkLines.push(JSON.stringify({ index: { _index: INDEX, _id: hit._id } }));
      bulkLines.push(JSON.stringify(hit._source));
    }
    const bulkBody = bulkLines.join("\n") + "\n";

    const bulkRes = await fetch(`${remoteUrl}/_bulk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        Authorization: `ApiKey ${apiKey}`,
      },
      body: bulkBody,
    });

    if (!bulkRes.ok) {
      throw new Error(`Bulk indexing failed: ${bulkRes.status}`);
    }

    const bulkJson = await bulkRes.json();
    if (bulkJson.errors) {
      const firstErr = bulkJson.items.find((i: any) => i.index?.error);
      console.error("Bulk error sample:", JSON.stringify(firstErr?.index?.error));
    }

    total += hits.length;
    console.log(`Indexed ${total} documents...`);

    // Next scroll
    const scrollRes = await fetchJson(`${LOCAL_ES}/_search/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scroll: "2m", scroll_id: scrollId }),
    });
    scrollId = scrollRes._scroll_id;
    hits = scrollRes.hits.hits;
  }

  console.log(`Done. Migrated ${total} documents to ${remoteUrl}/${INDEX}`);
}

run().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
