export function chunkText(
  text: string,
  options?: { chunkSize?: number; overlap?: number }
): string[] {
  const chunkSize = options?.chunkSize ?? 2048
  const overlap = options?.overlap ?? 256

  if (!text || text.length === 0) return []

  // Split on paragraph boundaries
  const paragraphs = text.split(/\n\s*\n/)
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    if (current.length + trimmed.length + 1 > chunkSize && current.length > 0) {
      chunks.push(current.trim())
      // Start next chunk with overlap from end of current
      const overlapText = current.slice(-overlap)
      current = overlapText + '\n\n' + trimmed
    } else {
      current = current ? current + '\n\n' + trimmed : trimmed
    }
  }

  if (current.trim()) {
    chunks.push(current.trim())
  }

  // If no paragraph splits worked, fall back to char-based chunking
  if (chunks.length === 0 && text.length > 0) {
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
      chunks.push(text.slice(i, i + chunkSize))
    }
  }

  return chunks
}
