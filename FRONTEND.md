# Frontend Integration Guide

## POST /api/analyze

The AI turn endpoint. Send the current canvas as a PNG + the user's prompt. Claude Vision interprets the canvas and draws back on it automatically.

**No API token needed** — the backend holds the Anthropic key.

### Request

```
POST /api/analyze
Content-Type: application/json
```

```json
{
  "image": "<base64 PNG string>",
  "prompt": "help me complete this diagram"
}
```

### Response

```json
{
  "success": true,
  "explanation": "Added a server box and connected it with arrows.",
  "count": 8
}
```

**Do not manually apply the response elements.** They are applied to the canvas and broadcast to all clients via WebSocket automatically. Just display the `explanation` string in the UI so the user knows what Claude did.

---

## Capturing the Canvas PNG

Use Excalidraw's `exportToBlob` to get the current canvas as a PNG, then convert to base64:

```ts
import { exportToBlob } from '@excalidraw/excalidraw'

async function analyzeCanvas(excalidrawAPI, userPrompt: string) {
  const blob = await exportToBlob({
    elements: excalidrawAPI.getSceneElements(),
    appState: excalidrawAPI.getAppState(),
    files: excalidrawAPI.getFiles(),
    mimeType: 'image/png',
  })

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64, prompt: userPrompt }),
  })

  const { success, explanation, count } = await res.json()

  if (!success) throw new Error('Analyze failed')

  // Show explanation in UI — elements already on canvas via WebSocket
  return explanation
}
```

---

## WebSocket Messages to Handle

When Claude draws, all connected clients receive:

```json
{
  "type": "elements_batch_created",
  "elements": [ ...ServerElement[] ]
}
```

This is already handled by the existing WebSocket message handler in `App.tsx` — no changes needed there.
