import { useRef, useState } from 'react'

// Minimal local types for Web Speech API (not in TS stdlib)
interface ISpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((e: ISpeechRecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

interface ISpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
}

type SpeechRecognitionCtor = new () => ISpeechRecognition

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
}

interface ClaudePanelProps {
  isOpen: boolean
  onClose: () => void
}

interface ChatHistoryEntry {
  prompt: string
  response: string
}

export function ClaudePanel({ isOpen, onClose }: ClaudePanelProps) {
  const [prompt, setPrompt] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [history, setHistory] = useState<ChatHistoryEntry[]>([])

  const recognitionRef = useRef<ISpeechRecognition | null>(null)

  const SpeechRecognitionClass: SpeechRecognitionCtor | undefined =
    window.SpeechRecognition ?? window.webkitSpeechRecognition
  const hasSpeech = !!SpeechRecognitionClass

  const startListening = () => {
    if (!SpeechRecognitionClass) return

    const recognition = new SpeechRecognitionClass()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (e: ISpeechRecognitionEvent) => {
      const transcript = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join('')
      setPrompt(transcript)
    }
    recognition.onend = () => setIsListening(false)
    recognition.onerror = () => setIsListening(false)

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }

  const stopListening = () => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }

  const handleSubmit = async () => {
    if (!prompt.trim()) return

    const currentPrompt = prompt.trim()
    setIsAnalyzing(true)
    setError(null)
    setExplanation(null)

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: currentPrompt }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Request failed (${res.status})`)
      }

      const data = (await res.json()) as { explanation?: string }
      const responseText = data.explanation ?? 'Done.'
      setExplanation(responseText)
      setHistory((prev) => [...prev, { prompt: currentPrompt, response: responseText }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setIsAnalyzing(false)
    }
  }

  return (
    <div className={`claude-panel${isOpen ? '' : ' hidden'}`}>
      <div className="claude-panel-header">
        <span>Ask Claude</span>
        <div className="claude-panel-header-actions">
          <button
            className={`claude-history-toggle${isHistoryOpen ? ' active' : ''}`}
            onClick={() => setIsHistoryOpen((v) => !v)}
            aria-label="Toggle chat history"
            aria-pressed={isHistoryOpen}
            title="Chat history"
          >
            💬
          </button>
          <button className="claude-close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </div>

      <div className="claude-panel-body">
        {isHistoryOpen && (
          <div className="claude-history">
            {history.length === 0 ? (
              <div className="claude-history-empty">No chats yet.</div>
            ) : (
              history.map((entry, idx) => (
                <div className="claude-history-item" key={`${idx}-${entry.prompt}`}>
                  <div className="claude-history-user">
                    <strong>You:</strong> {entry.prompt}
                  </div>
                  <div className="claude-history-claude">
                    <strong>Claude:</strong> {entry.response}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        <textarea
          className="claude-prompt"
          placeholder="Describe what to draw, or ask about the canvas…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSubmit()
          }}
          disabled={isAnalyzing}
        />

        <div className="claude-actions">
          {hasSpeech && (
            <button
              className={`claude-mic-btn${isListening ? ' listening' : ''}`}
              onClick={() => (isListening ? stopListening() : startListening())}
              disabled={isAnalyzing}
              title={isListening ? 'Stop recording' : 'Speak prompt'}
            >
              🎤
            </button>
          )}
          <button
            className="claude-submit-btn"
            onClick={() => void handleSubmit()}
            disabled={isAnalyzing || !prompt.trim()}
          >
            {isAnalyzing ? 'Thinking…' : 'Ask Claude →'}
          </button>
        </div>

        {explanation && (
          <div className="claude-response">
            <strong>Claude:</strong> {explanation}
          </div>
        )}

        {error && <div className="claude-error">Error: {error}</div>}
      </div>
    </div>
  )
}
