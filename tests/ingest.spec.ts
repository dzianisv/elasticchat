import { test, expect } from '@playwright/test';

/**
 * Ingest/Indexer verification tests.
 * These validate that:
 * 1. The /api/ingest endpoint works
 * 2. Elasticsearch has indexed blog data with correct schema
 * 3. Documents have embeddings (vector field)
 */

const BASE_URL = process.env.BASE_URL || 'https://elasticchat.vercel.app';
const ES_URL = process.env.ELASTICSEARCH_URL!;
const ES_API_KEY = process.env.ELASTICSEARCH_API_KEY!;

test.describe('Ingest & Indexer', () => {
  test('ingest endpoint returns success', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/ingest`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.indexed).toBeGreaterThanOrEqual(0);
    console.log(`Indexed: ${body.indexed} new documents`);
  });

  test('ES nvidia-blogs index has documents', async ({ request }) => {
    test.skip(!ES_URL || !ES_API_KEY, 'ES credentials not set');

    const response = await request.get(`${ES_URL}/nvidia-blogs/_count`, {
      headers: { Authorization: `ApiKey ${ES_API_KEY}` },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.count).toBeGreaterThan(0);
    console.log(`ES document count: ${body.count}`);
  });

  test('documents have correct schema (url, title, content, embedding)', async ({ request }) => {
    test.skip(!ES_URL || !ES_API_KEY, 'ES credentials not set');

    // Check document fields
    const response = await request.post(`${ES_URL}/nvidia-blogs/_search`, {
      headers: {
        Authorization: `ApiKey ${ES_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: { size: 1 },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    const doc = body.hits.hits[0]._source;

    // Required content fields
    expect(doc).toHaveProperty('url');
    expect(doc).toHaveProperty('title');
    expect(doc).toHaveProperty('content');

    // URL points to nvidia blog
    expect(doc.url).toMatch(/nvidia\.com/);
    // Content is non-empty
    expect(doc.content.length).toBeGreaterThan(20);

    console.log(`Sample doc: "${doc.title}" - ${doc.url}`);

    // Verify embedding field exists in mapping (dense_vector excluded from _source by default)
    const mappingRes = await request.get(`${ES_URL}/nvidia-blogs/_mapping`, {
      headers: { Authorization: `ApiKey ${ES_API_KEY}` },
    });
    expect(mappingRes.ok()).toBeTruthy();
    const mapping = await mappingRes.json();
    const properties = mapping['nvidia-blogs'].mappings.properties;
    expect(properties).toHaveProperty('embedding');
    expect(properties.embedding.type).toBe('dense_vector');
    expect(properties.embedding.dims).toBe(1024);
  });

  test('crawl-state index tracks processed URLs', async ({ request }) => {
    test.skip(!ES_URL || !ES_API_KEY, 'ES credentials not set');

    const response = await request.get(`${ES_URL}/crawl-state/_count`, {
      headers: { Authorization: `ApiKey ${ES_API_KEY}` },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.count).toBeGreaterThan(0);
    console.log(`Crawl state entries: ${body.count}`);
  });
});
