import { useRef, useState, useEffect } from 'react'

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

// ResponsiveVoice.js types
interface ResponsiveVoice {
  speak: (text: string, voice: string, options?: {
    pitch?: number
    rate?: number
    volume?: number
    onstart?: () => void
    onend?: () => void
    onerror?: () => void
  }) => void
  cancel: () => void
  isPlaying: () => boolean
  getVoices: () => Array<{ name: string }>
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
    responsiveVoice?: ResponsiveVoice
  }
}

interface ClaudePanelProps {
  isOpen: boolean
  onClose: () => void
}

export function ClaudePanel({ isOpen, onClose }: ClaudePanelProps) {
  const [prompt, setPrompt] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Debug ResponsiveVoice loading
  useEffect(() => {
    console.log('ClaudePanel mounted')
    console.log('ResponsiveVoice at mount:', !!window.responsiveVoice)

    // Check periodically if ResponsiveVoice loads
    const checkInterval = setInterval(() => {
      if (window.responsiveVoice) {
        console.log('ResponsiveVoice is now available!')
        clearInterval(checkInterval)
      }
    }, 1000)

    return () => clearInterval(checkInterval)
  }, [])

  const recognitionRef = useRef<ISpeechRecognition | null>(null)
  const speechSynthesisRef = useRef<SpeechSynthesisUtterance | null>(null)

  const SpeechRecognitionClass: SpeechRecognitionCtor | undefined =
    window.SpeechRecognition ?? window.webkitSpeechRecognition
  const hasSpeech = !!SpeechRecognitionClass
  const hasSpeechSynthesis = !!window.responsiveVoice || !!window.speechSynthesis

  // Cleanup speech synthesis on unmount
  useEffect(() => {
    return () => {
      if (window.responsiveVoice) {
        window.responsiveVoice.cancel()
      } else {
        window.speechSynthesis?.cancel()
      }
    }
  }, [])

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

  const speakResponse = (text: string) => {
    if (!hasSpeechSynthesis) return

    console.log('ResponsiveVoice available:', !!window.responsiveVoice)
    console.log('ResponsiveVoice object:', window.responsiveVoice)

    // Use ResponsiveVoice.js if available (better quality)
    if (window.responsiveVoice) {
      // Stop any current speech
      window.responsiveVoice.cancel()

      console.log('Using ResponsiveVoice.js for better quality TTS')

      // Try different voice names that should sound more distinctive
      const voiceOptions = [
        'UK English Female',  // British accent
        'Australian Female',  // Australian accent
        'US English Female',  // Standard US
        'UK English Male'     // Male British voice
      ]

      const voiceName = voiceOptions[0] // Start with UK English Female for distinctiveness

      console.log(`Attempting to use voice: ${voiceName}`)

      window.responsiveVoice.speak(text, voiceName, {
        pitch: 1.2,        // Higher pitch for more distinctiveness
        rate: 0.8,         // Slower for clarity
        volume: 1.0,
        onstart: () => {
          console.log('ResponsiveVoice started speaking')
          setIsSpeaking(true)
        },
        onend: () => {
          console.log('ResponsiveVoice finished speaking')
          setIsSpeaking(false)
        },
        onerror: (error: any) => {
          console.error('ResponsiveVoice error:', error)
          setIsSpeaking(false)
        }
      })
    } else {
      // Fallback to native Speech Synthesis API
      console.log('ResponsiveVoice not available, using fallback native Speech Synthesis API')

      window.speechSynthesis.cancel()

      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 0.8
      utterance.pitch = 1.15
      utterance.volume = 1.0

      utterance.onstart = () => {
        console.log('Native speech synthesis started')
        setIsSpeaking(true)
      }
      utterance.onend = () => {
        console.log('Native speech synthesis finished')
        setIsSpeaking(false)
      }
      utterance.onerror = () => {
        console.log('Native speech synthesis error')
        setIsSpeaking(false)
      }

      speechSynthesisRef.current = utterance
      window.speechSynthesis.speak(utterance)
    }
  }

  const stopSpeaking = () => {
    if (window.responsiveVoice) {
      window.responsiveVoice.cancel()
    } else {
      window.speechSynthesis.cancel()
    }
    setIsSpeaking(false)
  }

  const handleSubmit = async () => {
    if (!prompt.trim()) return

    setIsAnalyzing(true)
    setError(null)
    setExplanation(null)

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Request failed (${res.status})`)
      }

      const data = (await res.json()) as { explanation?: string }
      const response = data.explanation ?? 'Done.'
      setExplanation(response)

      console.log('About to call speakResponse with:', response)
      console.log('hasSpeechSynthesis:', hasSpeechSynthesis)

      // Speak the response instead of just displaying it
      if (hasSpeechSynthesis) {
        console.log('Calling speakResponse...')
        speakResponse(response)
      } else {
        console.log('Speech synthesis not available')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setError(errorMessage)
      console.log('Error occurred, about to speak error:', errorMessage)
      // Also speak errors
      if (hasSpeechSynthesis) {
        console.log('Speaking error message...')
        speakResponse(`Error: ${errorMessage}`)
      }
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
              disabled={isAnalyzing || isSpeaking}
              title={isListening ? 'Stop recording' : 'Speak prompt'}
            >
              🎤
            </button>
          )}
          <button
            className="claude-submit-btn"
            onClick={() => void handleSubmit()}
            disabled={isAnalyzing || !prompt.trim() || isSpeaking}
          >
            {isAnalyzing ? 'Thinking…' : isSpeaking ? 'Claude is speaking…' : 'Ask Claude →'}
          </button>
        </div>

        {isSpeaking && (
          <div className="claude-response claude-speaking">
            <strong>Claude is speaking...</strong> 🔊
            <br />
            <small>Click the mute button to stop</small>
          </div>
        )}

        {!isSpeaking && explanation && (
          <div className="claude-response">
            <strong>Claude:</strong> {explanation}
          </div>
        )}

        {error && <div className="claude-error">Error: {error}</div>}
      </div>
    </div>
  )
}
