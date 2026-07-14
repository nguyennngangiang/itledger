# Internal LLM / RAG server — API reference

Reference for the internal-network model server this app talks to. **What IT Ledger
actually uses today:** only `POST /v1/chat/completions` with `llama3.1:8b`, called from
`be/llm.py` (Ask AI, explain, rerank — see `chat` / `chat_agent`). The **vision** model
(`qwen2.5vl:7b`), the **RAG** endpoint (`/rag/chat`) and the server-side embedder
(`nomic-embed-text`) are available capabilities documented here for **future features** —
they are not wired into the app.

> Note: smart-search embeddings are produced by this app's **own** host NPU service
> (`ai/`, multilingual-e5-small on `:8001`) — **not** by this server's `nomic-embed-text`.
> Two separate embedding systems; don't confuse them.

## Auth & base URL

Every request goes through Caddy and needs:

```
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

The key lives in `D:\LLM\API_KEY.txt` on the server; in this app it's `LLM_API_KEY` in
`be/.env` (gitignored — never commit the real key). `be/llm.py::_chat` already sends the
`Authorization: Bearer` header.

| Where | Base URL |
|---|---|
| On the server | `http://127.0.0.1:8443` |
| On the LAN | `http://192.168.3.252:8443` |
| Public (later) | `https://<hostname-ddns>` — https, same paths/bodies |

App config: `LLM_BASE_URL=http://192.168.3.252:8443/v1` (`be/config.py`).

## Models (pick via the `"model"` field; all share one endpoint)

| Model | Use | Used by app? |
|---|---|---|
| `llama3.1:8b` | Plain text chat (strong text reasoning) | **Yes** (`LLM_MODEL`) |
| `qwen2.5vl:7b` | Multimodal: text **+ image reading** (OCR / tables / description) | No |
| `nomic-embed-text` | Embeddings only (vectors), not chat | No |

## Endpoints

| Method | Path | For |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-style chat (both chat models, supports images) |
| POST | `/v1/completions` | One-shot text (legacy) |
| POST | `/v1/embeddings` | OpenAI-style embeddings |
| GET  | `/v1/models` | List models |
| POST | `/api/chat` | Ollama-style chat (detailed `options`, images) |
| POST | `/api/generate` | Ollama-style single prompt (images) |
| POST | `/api/embed` | Ollama-style embeddings |
| GET  | `/api/tags` / `/api/ps` | Installed models / models loaded in VRAM |
| POST | `/rag/chat` | RAG: knowledge retrieval + citations (defaults to `qwen2.5vl:7b`) |
| GET  | `/rag/health` | RAG status |

---

## 1. `llama3.1:8b` — text chat

### OpenAI style — `POST /v1/chat/completions`
```json
{
  "model": "llama3.1:8b",
  "messages": [
    { "role": "system", "content": "Bạn là trợ lý tiếng Việt." },
    { "role": "user", "content": "Giải thích blockchain trong 2 câu." }
  ],
  "temperature": 0.7,
  "max_tokens": 512,
  "stream": false
}
```
Result: `choices[0].message.content`.

### Ollama style — `POST /api/chat` (tune via `options`)
```json
{
  "model": "llama3.1:8b",
  "messages": [{ "role": "user", "content": "Xin chào" }],
  "stream": false,
  "options": { "temperature": 0.7, "num_ctx": 8192, "top_p": 0.9, "top_k": 40 }
}
```
Result: `message.content`.

### Single prompt — `POST /api/generate`
```json
{ "model": "llama3.1:8b", "prompt": "Viết 1 câu chào.", "stream": false }
```
Result: `response`.

---

## 2. `qwen2.5vl:7b` — text + images

### Text only (same as above, change model)
```json
{ "model": "qwen2.5vl:7b", "messages": [{ "role": "user", "content": "Bạn làm được gì?" }], "stream": false }
```

### One image — OpenAI style (image = data URI, **with** prefix)
```json
{
  "model": "qwen2.5vl:7b",
  "messages": [
    { "role": "user", "content": [
      { "type": "text", "text": "Ảnh này có gì? Đọc chữ nếu có." },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ..." } }
    ]}
  ]
}
```

### One image — Ollama style (**raw** base64, no prefix)
`POST /api/generate`:
```json
{ "model": "qwen2.5vl:7b", "prompt": "Mô tả ảnh.", "images": ["/9j/4AAQ..."], "stream": false }
```
`POST /api/chat` (image attached to the message):
```json
{ "model": "qwen2.5vl:7b", "messages": [
  { "role": "user", "content": "Đọc bảng trong ảnh, xuất Markdown.", "images": ["<B64>"] }
], "stream": false }
```

### Multiple images
OpenAI — add several `image_url` parts:
```json
{ "model": "qwen2.5vl:7b", "messages": [
  { "role": "user", "content": [
    { "type": "text", "text": "So sánh 2 ảnh." },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<A1>" } },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<A2>" } }
  ]}
]}
```
Ollama — an `images` array with multiple items:
```json
{ "model": "qwen2.5vl:7b", "messages": [
  { "role": "user", "content": "So sánh 2 ảnh.", "images": ["<B64_1>", "<B64_2>"] }
], "stream": false }
```

### Extracting tables / structured data (prompt hints)
- "Đọc bảng trong ảnh, xuất **Markdown table** giữ đúng cột."
- "Trích thành **JSON**: mảng object, key = tên cột."
- "Xuất **CSV**." — Note: double-check important numbers (a 7B model can misread cells).

---

## 3. RAG — `POST /rag/chat` (private knowledge + citations)

No `model` field needed (defaults to `qwen2.5vl:7b`). `images` are **raw** base64.
```json
{
  "messages": [
    { "role": "user", "content": "SLA phản hồi ticket P1 là gì?" }
  ],
  "mode": "auto",
  "stream": false,
  "top_k": 5
}
```
- `mode`: `auto` (search web when the KB is weak) | `local` (KB only) | `web` | `target`.
- With images: add `"images": ["<B64>"]` to the message.
- Result: `{ "answer": "...[1]...", "sources": [ { "n":1, "title":"", "url":"", "origin":"kb|web|target" } ] }`.
- `GET /rag/health` → `{ ok, model, store: { count } }`.

---

## 4. Embeddings — `nomic-embed-text`

OpenAI — `POST /v1/embeddings`:
```json
{ "model": "nomic-embed-text", "input": "Câu cần vector hoá" }
```
Ollama — `POST /api/embed`:
```json
{ "model": "nomic-embed-text", "input": ["câu 1", "câu 2"] }
```

---

## 5. Examples by tool

### curl (text)
```bash
curl http://192.168.3.252:8443/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"llama3.1:8b","messages":[{"role":"user","content":"Hello"}]}'
```

### curl (image, Ollama style)
```bash
B64=$(base64 -w0 anh.jpg)
curl http://192.168.3.252:8443/api/generate \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d "{\"model\":\"qwen2.5vl:7b\",\"prompt\":\"Mô tả ảnh\",\"images\":[\"$B64\"],\"stream\":false}"
```

### Python — OpenAI SDK (`pip install openai`)
```python
from openai import OpenAI
client = OpenAI(base_url="http://192.168.3.252:8443/v1", api_key="<API_KEY>")

# text
r = client.chat.completions.create(model="llama3.1:8b",
    messages=[{"role":"user","content":"Xin chào"}])
print(r.choices[0].message.content)

# image
import base64
b64 = base64.b64encode(open("anh.jpg","rb").read()).decode()
r = client.chat.completions.create(model="qwen2.5vl:7b", messages=[
  {"role":"user","content":[
    {"type":"text","text":"Đọc bảng, xuất JSON."},
    {"type":"image_url","image_url":{"url":f"data:image/jpeg;base64,{b64}"}}
  ]}])
print(r.choices[0].message.content)
```

### Python — requests (RAG)
```python
import requests
r = requests.post("http://192.168.3.252:8443/rag/chat",
    headers={"Authorization":"Bearer <API_KEY>"},
    json={"messages":[{"role":"user","content":"SLA P1?"}],"mode":"auto"})
d = r.json(); print(d["answer"]); print(d["sources"])
```

### PowerShell (send UTF-8 body so Vietnamese isn't mangled)
```powershell
$key = (Get-Content 'D:\LLM\API_KEY.txt' -Raw).Trim()
$body = @{ model='qwen2.5vl:7b'; messages=@(@{role='user'; content='Chào bạn'}); stream=$false } |
        ConvertTo-Json -Compress -Depth 6
$bytes = [Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod 'http://127.0.0.1:8443/v1/chat/completions' -Method Post `
  -Headers @{Authorization="Bearer $key"} -Body $bytes `
  -ContentType 'application/json; charset=utf-8'
```
Make an image's base64 (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\anh.jpg'))`

---

## 6. Operational notes

- **base64 prefix**: OpenAI needs `data:image/...;base64,`; Ollama-native and `/rag/chat`
  take **raw** base64.
- **Compress images** first (~1024–1280px longest edge, JPEG q~80) → lighter payload,
  faster vision. base64 inflates size by ~33%.
- **`stream: true`**: OpenAI returns SSE `data:{...}`; Ollama returns NDJSON per line;
  `/rag/chat` streams `{delta}` … `{sources}` … `[DONE]`.
- **Shared 8GB VRAM**: switching models makes the first call ~6s slower (reloading into
  VRAM). A model leaves VRAM after 30 min (`OLLAMA_KEEP_ALIVE`).
- **Concurrency**: Ollama parallelism is limited → extra requests queue, latency rises.
- Use `127.0.0.1` → `192.168.3.252` to call from another LAN machine; once public, switch
  to `https://<hostname-ddns>`.
