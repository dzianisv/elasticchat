import { Client } from '@elastic/elasticsearch'

let _client: Client | null = null

export function getEs(): Client {
  if (!_client) {
    const opts: any = { node: process.env.ELASTICSEARCH_URL! }
    if (process.env.ELASTICSEARCH_API_KEY && process.env.ELASTICSEARCH_API_KEY !== 'unused') {
      opts.auth = { apiKey: process.env.ELASTICSEARCH_API_KEY }
    }
    _client = new Client(opts)
  }
  return _client
}

export const es = new Proxy({} as Client, {
  get(_, prop) {
    return (getEs() as any)[prop]
  },
})
