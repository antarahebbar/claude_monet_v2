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

// ResponsiveVoice.js types
interface ResponsiveVoice {
  speak: (
    text: string,
    voice: string,
    options?: {
      pitch?: number
      rate?: number
      volume?: number
      onstart?: () => void
      onend?: () => void
      onerror?: () => void
    },
  ) => void
  cancel: () => void
  isPlaying: () => boolean
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
    responsiveVoice?: ResponsiveVoice
  }
}

// ── ASR filtering ────────────────────────────────────────────────────────────

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

// ── Component ────────────────────────────────────────────────────────────────

interface ClaudePanelProps {
  isOpen: boolean
  onClose: () => void
}

export function ClaudePanel({ isOpen, onClose }: ClaudePanelProps) {
  const [manualPrompt, setManualPrompt] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSubmitted, setLastSubmitted] = useState<string | null>(null)

  const recognitionRef = useRef<ISpeechRecognition | null>(null)
  const speechSynthesisRef = useRef<SpeechSynthesisUtterance | null>(null)
  // Refs mirror state so recognition callbacks never see stale values
  const isListeningRef = useRef(false)
  const isSpeakingRef = useRef(false)

  const SpeechRecognitionClass: SpeechRecognitionCtor | undefined =
    window.SpeechRecognition ?? window.webkitSpeechRecognition
  const hasSpeech = !!SpeechRecognitionClass
  const hasTTS = !!window.responsiveVoice || !!window.speechSynthesis

  // Cancel any ongoing TTS when panel unmounts
  useEffect(() => {
    return () => {
      if (window.responsiveVoice) window.responsiveVoice.cancel()
      else window.speechSynthesis?.cancel()
    }
  }, [])

  // ── TTS ───────────────────────────────────────────────────────────────────

  const speakResponse = (text: string, onDone?: () => void) => {
    const handleEnd = () => {
      isSpeakingRef.current = false
      setIsSpeaking(false)
      onDone?.()
    }

    isSpeakingRef.current = true
    setIsSpeaking(true)

    if (window.responsiveVoice) {
      window.responsiveVoice.cancel()
      window.responsiveVoice.speak(text, 'UK English Female', {
        pitch: 1.2,
        rate: 0.8,
        volume: 1.0,
        onend: handleEnd,
        onerror: handleEnd,
      })
    } else if (window.speechSynthesis) {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 0.8
      utterance.pitch = 1.15
      utterance.volume = 1.0
      utterance.onend = handleEnd
      utterance.onerror = handleEnd
      speechSynthesisRef.current = utterance
      window.speechSynthesis.speak(utterance)
    } else {
      handleEnd()
    }
  }

  const stopSpeaking = () => {
    if (window.responsiveVoice) window.responsiveVoice.cancel()
    else window.speechSynthesis?.cancel()
    isSpeakingRef.current = false
    setIsSpeaking(false)
    // Resume listening if it was on
    if (isListeningRef.current && recognitionRef.current) {
      recognitionRef.current.start()
    }
  }

  // ── ASR ───────────────────────────────────────────────────────────────────

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

    // Auto-restart after silence — but not while TTS is playing
    recognition.onend = () => {
      if (isListeningRef.current && !isSpeakingRef.current) {
        recognition.start()
      }
    }

    recognition.onerror = () => {
      if (isListeningRef.current && !isSpeakingRef.current) {
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

  // M keybind toggles mic (ignored when focus is in a text field)
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

  // ── Submit helpers ────────────────────────────────────────────────────────

  // Called automatically after each final ASR result
  const autoSubmit = async (text: string) => {
    setLastSubmitted(text)
    setLiveTranscript('')
    setIsAnalyzing(true)
    setError(null)
    setExplanation(null)

    // Pause recognition while fetching + speaking to avoid mic feedback loop
    const wasListening = isListeningRef.current
    if (wasListening && hasTTS) {
      isSpeakingRef.current = true // blocks onend auto-restart
      recognitionRef.current?.stop()
    }

    const restartIfNeeded = () => {
      if (isListeningRef.current && recognitionRef.current) {
        recognitionRef.current.start()
      }
    }

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
      const response = data.explanation ?? 'Done.'
      setExplanation(response)
      speakResponse(response, wasListening && hasTTS ? restartIfNeeded : undefined)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setError(errorMessage)
      speakResponse(`Error: ${errorMessage}`, wasListening && hasTTS ? restartIfNeeded : undefined)
    } finally {
      setIsAnalyzing(false)
    }
  }

  // Called from manual textarea submit
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
      const response = data.explanation ?? 'Done.'
      setExplanation(response)
      speakResponse(response)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setError(errorMessage)
      speakResponse(`Error: ${errorMessage}`)
    } finally {
      setIsAnalyzing(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const micStatus = isSpeaking
    ? 'Claude is speaking…'
    : isListening
      ? liveTranscript || 'Listening…'
      : 'Mic off'

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
              disabled={isSpeaking}
              title={isListening ? 'Stop listening (M)' : 'Start listening (M)'}
            >
              🎤
            </button>
            <span className="claude-mic-status">{micStatus}</span>
            {isSpeaking && (
              <button className="claude-stop-btn" onClick={stopSpeaking} title="Stop speaking">
                ⏹
              </button>
            )}
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
            disabled={isAnalyzing || !manualPrompt.trim() || isSpeaking}
          >
            {isAnalyzing ? 'Thinking…' : isSpeaking ? 'Speaking…' : 'Ask Claude →'}
          </button>
        </div>

        {explanation && (
          <div className={`claude-response${isSpeaking ? ' claude-speaking' : ''}`}>
            <strong>Claude:</strong> {explanation} {isSpeaking && '🔊'}
          </div>
        )}

        {error && <div className="claude-error">Error: {error}</div>}
      </div>
    </div>
  )
}
