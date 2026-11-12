// The language and embedding models, through a local Ollama server (plans/chat-discovery.md 2.1).
// One small interface so a hosted model could be swapped in later by config.
//
//   OLLAMA_URL   default http://127.0.0.1:11434
//   CHAT_MODEL   default qwen3:4b-instruct (fits a 6 GB GPU; must be a non-thinking/instruct model)
//   EMBED_MODEL  default mxbai-embed-large (must match the model data/ai was built with)

const URL_ = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen3:4b-instruct';
export const EMBED_MODEL = process.env.EMBED_MODEL || 'mxbai-embed-large';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OfflineError extends Error {}

/** Whether the chat model accepts `think` (instruct-only models reject it); learnt on first use. */
let thinkParam = true;

async function post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  if (!thinkParam) delete body.think;
  let res: Response;
  try {
    res = await fetch(`${URL_}${path}`, { method: 'POST', body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError') throw e;
    throw new OfflineError(`Can't reach Ollama at ${URL_}`);
  }
  if (res.status === 400 && 'think' in body) {
    const text = await res.text();
    if (/think/i.test(text)) {
      thinkParam = false;
      return post(path, body, signal);
    }
    throw new Error(`Ollama ${path}: HTTP 400 ${text.slice(0, 160)}`);
  }
  if (res.status === 404) throw new OfflineError(`Model missing in Ollama: ${(await res.text()).slice(0, 160)}`);
  if (!res.ok) throw new Error(`Ollama ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res;
}

/** Whether Ollama answers within a moment. */
export async function available() {
  try {
    const res = await fetch(`${URL_}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** L2-normalised embeddings. nomic-embed-text wants a task prefix on every text. */
export async function embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
  const prefix = EMBED_MODEL.includes('nomic')
    ? kind === 'query' ? 'search_query: ' : 'search_document: '
    : EMBED_MODEL.includes('mxbai') && kind === 'query' ? 'Represent this sentence for searching relevant passages: ' : '';
  const res = await post('/api/embed', { model: EMBED_MODEL, input: texts.map(t => prefix + t) }, signal);
  const { embeddings } = (await res.json()) as { embeddings: number[][] };
  return embeddings.map(e => {
    const n = Math.hypot(...e) || 1;
    return Float32Array.from(e, x => x / n);
  });
}

// num_predict caps a runaway reply (a few hundred tokens is plenty for an answer or a query).
const options = (temperature: number) => ({ temperature, num_ctx: 8192, num_predict: 600 });

/** A reply constrained to a JSON schema (Ollama structured outputs). */
export async function chatJson(messages: ChatMessage[], schema: object, signal?: AbortSignal): Promise<unknown> {
  const res = await post('/api/chat', { model: CHAT_MODEL, messages, format: schema, stream: false, think: false, options: options(0) }, signal);
  const { message } = (await res.json()) as { message: { content: string } };
  return JSON.parse(message.content);
}

/** A streamed plain-text reply. */
export async function* chatStream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
  const res = await post('/api/chat', { model: CHAT_MODEL, messages, stream: true, think: false, options: options(0.4) }, signal);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
      if (msg.message?.content) yield msg.message.content;
    }
  }
}
