export const NVIDIA_BLOGS_INDEX = 'nvidia-blogs'
export const CRAWL_STATE_INDEX = 'crawl-state'

export const nvidiaBlogsMapping = {
  mappings: {
    properties: {
      url: { type: 'keyword' as const },
      title: { type: 'text' as const },
      author: { type: 'keyword' as const },
      date: { type: 'date' as const },
      content: { type: 'text' as const },
      chunk_index: { type: 'integer' as const },
      embedding: { type: 'dense_vector' as const, dims: 1536, index: true, similarity: 'cosine' as const },
    },
  },
}

export const crawlStateMapping = {
  mappings: {
    properties: {
      url: { type: 'keyword' as const },
      content_hash: { type: 'keyword' as const },
      last_crawled: { type: 'date' as const },
    },
  },
}
