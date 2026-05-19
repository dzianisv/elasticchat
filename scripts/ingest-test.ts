import * as cheerio from 'cheerio';
import { embedTexts } from '../src/lib/embeddings';
import { Client } from '@elastic/elasticsearch';
import * as crypto from 'crypto';

process.env.AZURE_DEV_AI_API_KEY = 'REDACTED';
process.env.AZURE_DEV_AI_BASE_URL = 'https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1';

const es = new Client({ node: 'http://localhost:9200' });

async function main() {
  const rssRes = await fetch('https://blogs.nvidia.com/feed/');
  const rssText = await rssRes.text();
  const $ = cheerio.load(rssText, { xmlMode: true });
  const items = $('item').toArray().slice(0, 5);
  console.log('Processing', items.length, 'posts');

  for (const item of items) {
    const title = $(item).find('title').text();
    const link = $(item).find('link').text();
    const pubDate = $(item).find('pubDate').text();
    const author = $(item).find('dc\\:creator').text();

    console.log('Fetching:', title.slice(0, 60));
    const pageRes = await fetch(link);
    const pageHtml = await pageRes.text();
    const page = cheerio.load(pageHtml);
    const content = page('.entry-content, .post-content, article').text().replace(/\s+/g, ' ').trim().slice(0, 5000);

    if (!content) { console.log('  No content, skipping'); continue; }

    const chunkSize = 1500;
    const overlap = 200;
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize - overlap) {
      chunks.push(content.slice(i, i + chunkSize));
    }

    const embeddings = await embedTexts(chunks);
    console.log('  Chunks:', chunks.length, 'Embedded');

    const ops = chunks.flatMap((chunk, i) => [
      { index: { _index: 'nvidia-blogs', _id: link + '#' + i } },
      { url: link, title, author, date: new Date(pubDate).toISOString(), content: chunk, chunk_index: i, embedding: embeddings[i] }
    ]);
    await es.bulk({ body: ops });

    await es.index({ index: 'crawl-state', id: link, document: { url: link, content_hash: crypto.createHash('md5').update(content).digest('hex'), last_crawled: new Date().toISOString() } });
    console.log('  Indexed');
  }

  const count = await es.count({ index: 'nvidia-blogs' });
  console.log('Total docs in index:', count.count);
}

main().catch(console.error);
