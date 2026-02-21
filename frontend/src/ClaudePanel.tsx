import { useEffect, useRef, useState } from 'react'

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
  resultIndex: number
}

type SpeechRecognitionCtor = new () => ISpeechRecognition

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
}

const FILLER_WORDS = new Set([
  'um', 'uh', 'hmm', 'hm', 'ah', 'er', 'okay', 'ok',
  'mhm', 'mmm', 'mm', 'yeah', 'yep', 'nope',
])

const MIN_MEANINGFUL_WORDS = 2

function shouldSubmit(text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const meaningful = words.filter((w) => !FILLER_WORDS.has(w))
  return meaningful.length >= MIN_MEANINGFUL_WORDS
}

interface ClaudePanelProps {
  isOpen: boolean
  onClose: () => void
}

export function ClaudePanel({ isOpen, onClose }: ClaudePanelProps) {
  const [manualPrompt, setManualPrompt] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSubmitted, setLastSubmitted] = useState<string | null>(null)

  const recognitionRef = useRef<ISpeechRecognition | null>(null)
  const isListeningRef = useRef(false)

  const SpeechRecognitionClass: SpeechRecognitionCtor | undefined =
    window.SpeechRecognition ?? window.webkitSpeechRecognition
  const hasSpeech = !!SpeechRecognitionClass

  const autoSubmit = async (text: string) => {
    setLastSubmitted(text)
    setLiveTranscript('')
    setIsAnalyzing(true)
    setError(null)
    setExplanation(null)

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Request failed (${res.status})`)
      }

      const data = (await res.json()) as { explanation?: string }
      setExplanation(data.explanation ?? 'Done.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const startRecognition = () => {
    if (!SpeechRecognitionClass) return

    const recognition = new SpeechRecognitionClass()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (e: ISpeechRecognitionEvent) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0].transcript
        if (result.isFinal) {
          const trimmed = text.trim()
          if (trimmed && shouldSubmit(trimmed)) void autoSubmit(trimmed)
        } else {
          interim += text
        }
      }
      setLiveTranscript(interim)
    }

    recognition.onend = () => {
      if (isListeningRef.current) {
        recognition.start()
      }
    }

    recognition.onerror = () => {
      if (isListeningRef.current) {
        setTimeout(() => recognition.start(), 300)
      }
    }

    recognitionRef.current = recognition
    recognition.start()
  }

  const toggleListening = () => {
    if (isListening) {
      isListeningRef.current = false
      recognitionRef.current?.stop()
      setIsListening(false)
      setLiveTranscript('')
    } else {
      isListeningRef.current = true
      setIsListening(true)
      startRecognition()
    }
  }

  useEffect(() => {
    if (!hasSpeech || !isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      toggleListening()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, isListening, hasSpeech])

  const handleSubmit = async () => {
    if (!manualPrompt.trim()) return

    setIsAnalyzing(true)
    setError(null)
    setExplanation(null)

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: manualPrompt.trim() }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Request failed (${res.status})`)
      }

      const data = (await res.json()) as { explanation?: string }
      setExplanation(data.explanation ?? 'Done.')
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
        <button onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="claude-panel-body">
        {hasSpeech && (
          <div className="claude-voice-section">
            <button
              className={`claude-mic-btn${isListening ? ' listening' : ''}`}
              onClick={toggleListening}
              title={isListening ? 'Stop listening (M)' : 'Start listening (M)'}
            >
              🎤
            </button>
            <span className="claude-mic-status">
              {isListening
                ? liveTranscript || 'Listening…'
                : 'Mic off'}
            </span>
          </div>
        )}

        {lastSubmitted && (
          <div className="claude-submitted">You: {lastSubmitted}</div>
        )}

        <textarea
          className="claude-prompt"
          placeholder="Describe what to draw, or ask about the canvas…"
          value={manualPrompt}
          onChange={(e) => setManualPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSubmit()
          }}
          disabled={isAnalyzing}
        />

        <div className="claude-actions">
          <button
            className="claude-submit-btn"
            onClick={() => void handleSubmit()}
            disabled={isAnalyzing || !manualPrompt.trim()}
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
