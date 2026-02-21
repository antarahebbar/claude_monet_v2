import Anthropic from '@anthropic-ai/sdk';

export interface AIElement {
  id?: string;       // required for deleteElement / updateElement
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  fillStyle?: string;
  text?: string;
  fontSize?: number;
  points?: number[][];
  endArrowhead?: string;
  startArrowhead?: string;
}

export interface AIAction {
  action: 'addShape' | 'addArrow' | 'addText' | 'updateElement' | 'deleteElement';
  element: AIElement;
}

export interface AIResponse {
  explanation: string;
  actions: AIAction[];
}

const SYSTEM_PROMPT = `You are Claude Monet — an AI visual thinking partner embedded in an Excalidraw collaborative whiteboard.

Your role: understand the user's intent and either answer their question conversationally OR modify the canvas with drawing actions — but never both unnecessarily, and never modify the canvas when the user is just asking a question.

RULES:
1. Return ONLY valid JSON — no markdown fences, no prose, no text outside the JSON object.
2. Analyze the canvas elements carefully: understand shapes, text, arrows, and their spatial relationships from the JSON data.
3. If the user is asking a question (e.g. "what's on the canvas?", "explain this", "how many shapes?"), answer in "explanation" and return "actions": []. Do NOT add elements to the canvas for informational requests.
4. If the user wants to draw or modify something, use actions to do so. Keep responses focused: 3–10 actions maximum.
5. Position new elements relative to existing content to avoid overlap unless intentional.
6. For text elements, always include width and height. Estimate: width = max(200, text.length * fontSize * 0.6), height = fontSize * 2.
7. For arrows, points are offsets from the arrow's origin (x,y). Example: [[0,0],[150,0]] is a 150px horizontal arrow.

RESPONSE SCHEMA (return exactly this shape):
{
  "explanation": "Conversational answer or one sentence describing what you did.",
  "actions": [
    {
      "action": "addShape",
      "element": { "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 80, "strokeColor": "#1971c2", "backgroundColor": "#e7f5ff", "strokeWidth": 2 }
    },
    {
      "action": "addText",
      "element": { "type": "text", "x": 120, "y": 130, "text": "API Gateway", "fontSize": 16, "width": 200, "height": 32 }
    },
    {
      "action": "addArrow",
      "element": { "type": "arrow", "x": 300, "y": 140, "points": [[0, 0], [150, 0]], "strokeColor": "#000000", "strokeWidth": 2, "endArrowhead": "arrow" }
    },
    {
      "action": "deleteElement",
      "element": { "id": "abc123" }
    }
  ]
}

AVAILABLE ACTIONS:
- addShape: adds a rectangle, ellipse, or diamond. Required: type, x, y, width, height.
- addText: adds a text label. Required: type="text", x, y, text, fontSize, width, height.
- addArrow: adds a directional arrow. Required: type="arrow", x, y, points (array of [x,y] offsets).
- deleteElement: removes an existing element by id. Required: id (from the canvas element data). No other fields needed.

STYLING GUIDE (use color with intent):
- Blue  — new component or system box: strokeColor "#1971c2", backgroundColor "#e7f5ff"
- Orange — warning, bottleneck, or attention: strokeColor "#e67700", backgroundColor "#fff9db"
- Green  — output, success, or result: strokeColor "#2f9e44", backgroundColor "#ebfbee"
- Default (neutral): strokeColor "#000000", backgroundColor "transparent", strokeWidth 2
- For text inside shapes, offset x by +10–20px and y by +10–15px from the shape's top-left corner.`;

function extractJSON(raw: string): string {
  const fenceMatch = raw.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw.trim();
}

export class ClaudeVisionService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: process.env.CLAUDE_API_KEY!,
    });
  }

  async generateActions(prompt: string, canvasElements: object[]): Promise<AIResponse> {
    const elementsJson = JSON.stringify(canvasElements, null, 2);

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Current canvas elements:\n\`\`\`json\n${elementsJson}\n\`\`\`\n\nUser request: ${prompt}`,
            },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (!content || content.type !== 'text') {
      throw new Error('Unexpected response type from Claude API');
    }

    let parsed: AIResponse;
    try {
      parsed = JSON.parse(extractJSON(content.text)) as AIResponse;
    } catch {
      throw new Error('Claude returned invalid JSON');
    }

    if (!Array.isArray(parsed.actions)) {
      throw new Error('Claude response missing actions array');
    }

    return parsed;
  }
}
