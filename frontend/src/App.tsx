import React, { useState, useEffect, useRef } from "react";
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/types/element/types";
import {
  convertMermaidToExcalidraw,
  DEFAULT_MERMAID_CONFIG,
} from "./utils/mermaidConverter";
import type { MermaidConfig } from "@excalidraw/mermaid-to-excalidraw";

// ── Speech recognition types ──────────────────────────────────
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
interface ResponsiveVoice {
  speak: (text: string, voice: string, options?: { pitch?: number; rate?: number; volume?: number; onstart?: () => void; onend?: () => void; onerror?: () => void }) => void
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
const FILLER_WORDS = new Set([
  'um', 'uh', 'hmm', 'hm', 'ah', 'er', 'okay', 'ok',
  'mhm', 'mmm', 'mm', 'yeah', 'yep', 'nope',
])
function shouldSubmit(text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const meaningful = words.filter((w) => !FILLER_WORDS.has(w))
  return meaningful.length >= 2
}

interface ChatMessage {
  role: 'user' | 'claude'
  text: string
  ts: number
}

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;
  // Arrow element binding
  start?: { id: string };
  end?: { id: string };
  strokeStyle?: string;
  endArrowhead?: string;
  startArrowhead?: string;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = "idle" | "syncing" | "success" | "error";

// Helper function to clean elements for Excalidraw
const cleanElementForExcalidraw = (
  element: ServerElement,
): Partial<ExcalidrawElement> => {
  const {
    createdAt,
    updatedAt,
    version,
    syncedAt,
    source,
    syncTimestamp,
    ...cleanElement
  } = element;
  return cleanElement;
};

// Helper function to validate and fix element binding data
const validateAndFixBindings = (
  elements: Partial<ExcalidrawElement>[],
): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map((el) => [el.id!, el]));

  return elements.map((element) => {
    const fixedElement = { ...element };

    // Validate and fix boundElements
    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter(
          (binding: any) => {
            // Ensure binding has required properties
            if (!binding || typeof binding !== "object") return false;
            if (!binding.id || !binding.type) return false;

            // Ensure the referenced element exists
            const referencedElement = elementMap.get(binding.id);
            if (!referencedElement) return false;

            // Validate binding type
            if (!["text", "arrow"].includes(binding.type)) return false;

            return true;
          },
        );

        // Remove boundElements if empty
        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        // Invalid boundElements format, set to null
        fixedElement.boundElements = null;
      }
    }

    // Validate and fix containerId
    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        // Container doesn't exist, remove containerId
        fixedElement.containerId = null;
      }
    }

    return fixedElement;
  });
};

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawAPIRefValue | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const websocketRef = useRef<WebSocket | null>(null);

  // Mic / voice state
  const SpeechRecognitionClass: SpeechRecognitionCtor | undefined =
    window.SpeechRecognition ?? window.webkitSpeechRecognition
  const hasSpeech = !!SpeechRecognitionClass
  const hasTTS = !!window.responsiveVoice || !!window.speechSynthesis
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [liveTranscript, setLiveTranscript] = useState('')
  const isListeningRef = useRef(false)
  const isSpeakingRef = useRef(false)
  const recognitionRef = useRef<ISpeechRecognition | null>(null)
  const speechSynthesisRef = useRef<SpeechSynthesisUtterance | null>(null)

  // Chat history
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  // Sync state management
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  // Auto-sync debouncing
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // ── TTS ────────────────────────────────────────────────────
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
        pitch: 1.2, rate: 0.8, volume: 1.0, onend: handleEnd, onerror: handleEnd,
      })
    } else if (window.speechSynthesis) {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 0.8; utterance.pitch = 1.15; utterance.volume = 1.0
      utterance.onend = handleEnd; utterance.onerror = handleEnd
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
    if (isListeningRef.current && recognitionRef.current) {
      recognitionRef.current.start()
    }
  }

  // ── Mic logic ──────────────────────────────────────────────
  const autoSubmitVoice = async (text: string) => {
    setLiveTranscript('')
    setChatHistory((h) => [...h, { role: 'user', text, ts: Date.now() }])
    const wasListening = isListeningRef.current
    if (wasListening && hasTTS) {
      isSpeakingRef.current = true
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
      const data = await res.json() as { explanation?: string }
      if (data.explanation) {
        setChatHistory((h) => [...h, { role: 'claude', text: data.explanation!, ts: Date.now() }])
        speakResponse(data.explanation, wasListening && hasTTS ? restartIfNeeded : undefined)
      } else if (wasListening && hasTTS) {
        isSpeakingRef.current = false
        restartIfNeeded()
      }
    } catch (err) {
      console.error('Voice submit error:', err)
      if (wasListening && hasTTS) {
        isSpeakingRef.current = false
        restartIfNeeded()
      }
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
        if (result.isFinal) {
          const trimmed = result[0].transcript.trim()
          if (trimmed && shouldSubmit(trimmed)) void autoSubmitVoice(trimmed)
        } else {
          interim += result[0].transcript
        }
      }
      setLiveTranscript(interim)
    }
    recognition.onend = () => {
      if (isListeningRef.current && !isSpeakingRef.current) recognition.start()
    }
    recognition.onerror = () => {
      if (isListeningRef.current && !isSpeakingRef.current) setTimeout(() => recognition.start(), 300)
    }
    recognitionRef.current = recognition
    recognition.start()
  }

  const toggleListening = () => {
    if (!hasSpeech) return
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

  // M keybind toggles mic (skips input/textarea focus)
  useEffect(() => {
    if (!hasSpeech) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      toggleListening()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isListening, hasSpeech])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory])

  // WebSocket connection
  useEffect(() => {
    connectWebSocket();
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close();
      }
    };
  }, []);

  // Load existing elements when Excalidraw API becomes available
  useEffect(() => {
    if (excalidrawAPI) {
      loadExistingElements();

      // Ensure WebSocket is connected for real-time updates
      if (!isConnected) {
        connectWebSocket();
      }
    }
  }, [excalidrawAPI, isConnected]);

  const loadExistingElements = async (): Promise<void> => {
    try {
      const response = await fetch("/api/elements");
      const result: ApiResponse = await response.json();

      if (result.success && result.elements && result.elements.length > 0) {
        const cleanedElements = result.elements.map(cleanElementForExcalidraw);
        const convertedElements = convertToExcalidrawElements(cleanedElements, {
          regenerateIds: false,
        });
        excalidrawAPI?.updateScene({ elements: convertedElements });
      }
    } catch (error) {
      console.error("Error loading existing elements:", error);
    }
  };

  const connectWebSocket = (): void => {
    if (
      websocketRef.current &&
      websocketRef.current.readyState === WebSocket.OPEN
    ) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}`;

    websocketRef.current = new WebSocket(wsUrl);

    websocketRef.current.onopen = () => {
      setIsConnected(true);

      if (excalidrawAPI) {
        setTimeout(loadExistingElements, 100);
      }
    };

    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data);
        handleWebSocketMessage(data);
      } catch (error) {
        console.error("Error parsing WebSocket message:", error, event.data);
      }
    };

    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false);

      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000);
      }
    };

    websocketRef.current.onerror = (error: Event) => {
      console.error("WebSocket error:", error);
      setIsConnected(false);
    };
  };

  const handleWebSocketMessage = async (
    data: WebSocketMessage,
  ): Promise<void> => {
    if (!excalidrawAPI) {
      return;
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements();
      console.log("Current elements:", currentElements);

      switch (data.type) {
        case "initial_elements":
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(
              cleanElementForExcalidraw,
            );
            const validatedElements = validateAndFixBindings(cleanedElements);
            // Preserve server IDs so later update/delete websocket events can match by id.
            const convertedElements = convertToExcalidrawElements(
              validatedElements,
              { regenerateIds: false },
            );
            excalidrawAPI.updateScene({
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
          break;

        case "element_created":
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element);
            const hasBindings =
              (cleanedNewElement as any).start ||
              (cleanedNewElement as any).end;
            if (hasBindings) {
              // Bound arrow: re-convert all elements together so bindings resolve
              const allElements = [
                ...currentElements,
                cleanedNewElement,
              ] as any[];
              const convertedAll = convertToExcalidrawElements(allElements, {
                regenerateIds: false,
              });
              excalidrawAPI.updateScene({
                elements: convertedAll,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            } else {
              // Preserve server IDs so later update/delete websocket events can match by id.
              const newElement = convertToExcalidrawElements(
                [cleanedNewElement],
                { regenerateIds: false },
              );
              const updatedElementsAfterCreate = [
                ...currentElements,
                ...newElement,
              ];
              excalidrawAPI.updateScene({
                elements: updatedElementsAfterCreate,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
          break;

        case "element_updated":
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(
              data.element,
            );
            // Preserve server IDs so we can replace the existing element by id.
            const convertedUpdatedElement = convertToExcalidrawElements(
              [cleanedUpdatedElement],
              { regenerateIds: false },
            )[0];
            const updatedElements = currentElements.map((el) =>
              el.id === data.element!.id ? convertedUpdatedElement : el,
            );
            excalidrawAPI.updateScene({
              elements: updatedElements,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
          break;

        case "element_deleted":
          if (data.elementId) {
            const filteredElements = currentElements.filter(
              (el) => el.id !== data.elementId,
            );
            excalidrawAPI.updateScene({
              elements: filteredElements,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
          break;

        case "elements_batch_created":
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(
              cleanElementForExcalidraw,
            );
            const hasBoundArrows = cleanedBatchElements.some(
              (el: any) => el.start || el.end,
            );
            if (hasBoundArrows) {
              // Convert ALL elements together so arrow bindings resolve to target shapes
              const allElements = [
                ...currentElements,
                ...cleanedBatchElements,
              ] as any[];
              const convertedAll = convertToExcalidrawElements(allElements, {
                regenerateIds: false,
              });
              excalidrawAPI.updateScene({
                elements: convertedAll,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            } else {
              // Preserve server IDs so later update/delete websocket events can match by id.
              const batchElements = convertToExcalidrawElements(
                cleanedBatchElements,
                { regenerateIds: false },
              );
              const updatedElementsAfterBatch = [
                ...currentElements,
                ...batchElements,
              ];
              excalidrawAPI.updateScene({
                elements: updatedElementsAfterBatch,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
          break;

        case "elements_synced":
          console.log(`Sync confirmed by server: ${data.count} elements`);
          // Sync confirmation already handled by HTTP response
          break;

        case "sync_status":
          console.log(`Server sync status: ${data.count} elements`);
          break;

        case "canvas_cleared":
          console.log("Canvas cleared by server");
          excalidrawAPI.updateScene({
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          break;

        case "export_image_request":
          console.log("Received image export request", data);
          if (data.requestId) {
            try {
              const elements = excalidrawAPI.getSceneElements();
              const appState = excalidrawAPI.getAppState();
              const files = excalidrawAPI.getFiles();

              if (data.format === "svg") {
                const svg = await exportToSvg({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false,
                  },
                  files,
                });
                const svgString = new XMLSerializer().serializeToString(svg);
                await fetch("/api/export/image/result", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: "svg",
                    data: svgString,
                  }),
                });
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false,
                  },
                  files,
                  mimeType: "image/png",
                });
                const reader = new FileReader();
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string;
                    const base64 = resultString?.split(",")[1];
                    if (!base64) {
                      throw new Error(
                        "Could not extract base64 data from result",
                      );
                    }
                    await fetch("/api/export/image/result", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: "png",
                        data: base64,
                      }),
                    });
                  } catch (readerError) {
                    console.error(
                      "Image export (FileReader) failed:",
                      readerError,
                    );
                    await fetch("/api/export/image/result", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message,
                      }),
                    }).catch(() => {});
                  }
                };
                reader.onerror = async () => {
                  console.error("FileReader error:", reader.error);
                  await fetch("/api/export/image/result", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || "FileReader failed",
                    }),
                  }).catch(() => {});
                };
                reader.readAsDataURL(blob);
              }
              console.log("Image export completed for request", data.requestId);
            } catch (exportError) {
              console.error("Image export failed:", exportError);
              await fetch("/api/export/image/result", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message,
                }),
              });
            }
          }
          break;

        case "set_viewport":
          console.log("Received viewport control request", data);
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = excalidrawAPI.getSceneElements();
                if (allElements.length > 0) {
                  excalidrawAPI.scrollToContent(allElements, {
                    fitToViewport: true,
                    animate: true,
                  });
                }
              } else if (data.scrollToElementId) {
                const allElements = excalidrawAPI.getSceneElements();
                const targetElement = allElements.find(
                  (el) => el.id === data.scrollToElementId,
                );
                if (targetElement) {
                  excalidrawAPI.scrollToContent([targetElement], {
                    fitToViewport: false,
                    animate: true,
                  });
                } else {
                  throw new Error(
                    `Element ${data.scrollToElementId} not found`,
                  );
                }
              } else {
                // Direct zoom/scroll control
                const appState: any = {};
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom };
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX;
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY;
                }
                if (Object.keys(appState).length > 0) {
                  excalidrawAPI.updateScene({ appState });
                }
              }

              await fetch("/api/viewport/result", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: "Viewport updated",
                }),
              });
            } catch (viewportError) {
              console.error("Viewport control failed:", viewportError);
              await fetch("/api/viewport/result", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message,
                }),
              }).catch(() => {});
            }
          }
          break;

        case "mermaid_convert":
          console.log("Received Mermaid conversion request from MCP");
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(
                data.mermaidDiagram,
                data.config || DEFAULT_MERMAID_CONFIG,
              );

              if (result.error) {
                console.error("Mermaid conversion error:", result.error);
                return;
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(
                  result.elements,
                  { regenerateIds: false },
                );
                excalidrawAPI.updateScene({
                  elements: convertedElements,
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY,
                });

                if (result.files) {
                  excalidrawAPI.addFiles(Object.values(result.files));
                }

                console.log(
                  "Mermaid diagram converted successfully:",
                  result.elements.length,
                  "elements",
                );

                // Sync to backend automatically after creating elements
                await syncToBackend();
              }
            } catch (error) {
              console.error(
                "Error converting Mermaid diagram from WebSocket:",
                error,
              );
            }
          }
          break;

        default:
          console.log("Unknown WebSocket message type:", data.type);
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error, data);
    }
  };

  // Data format conversion for backend
  const convertToBackendFormat = (
    element: ExcalidrawElement,
  ): ServerElement => {
    return {
      ...element,
    } as ServerElement;
  };

  // Format sync time display
  const formatSyncTime = (time: Date | null): string => {
    if (!time) return "";
    return time.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  // Main sync function
  const syncToBackend = async (): Promise<void> => {
    if (!excalidrawAPI) {
      console.warn("Excalidraw API not available");
      return;
    }

    setSyncStatus("syncing");

    try {
      // 1. Get current elements
      const currentElements = excalidrawAPI.getSceneElements();
      console.log(`Syncing ${currentElements.length} elements to backend`);

      // Filter out deleted elements
      const activeElements = currentElements.filter((el) => !el.isDeleted);

      // 3. Convert to backend format
      const backendElements = activeElements.map(convertToBackendFormat);

      // 4. Send to backend
      const response = await fetch("/api/elements/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          elements: backendElements,
          timestamp: new Date().toISOString(),
        }),
      });

      if (response.ok) {
        const result: ApiResponse = await response.json();
        setSyncStatus("success");
        setLastSyncTime(new Date());
        console.log(`Sync successful: ${result.count} elements synced`);

        // Reset status after 2 seconds
        setTimeout(() => setSyncStatus("idle"), 2000);
      } else {
        const error: ApiResponse = await response.json();
        setSyncStatus("error");
        console.error("Sync failed:", error.error);
      }
    } catch (error) {
      setSyncStatus("error");
      console.error("Sync error:", error);
    }
  };

  // Auto-sync with debouncing to avoid excessive API calls
  const debouncedAutoSync = async (): Promise<void> => {
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }

    syncTimeoutRef.current = setTimeout(async () => {
      try {
        await syncToBackend();
      } catch (error) {
        console.error("Auto-sync failed:", error);
      }
    }, 1000); // Wait 1 second after last change before syncing
  };

  // Handle canvas changes
  const handleCanvasChange = (elements: readonly ExcalidrawElement[]) => {
    // Trigger auto-sync after debounce delay
    debouncedAutoSync();
  };

  const clearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
        // Get all current elements and delete them from backend
        const response = await fetch("/api/elements");
        const result: ApiResponse = await response.json();

        if (result.success && result.elements) {
          const deletePromises = result.elements.map((element) =>
            fetch(`/api/elements/${element.id}`, { method: "DELETE" }),
          );
          await Promise.all(deletePromises);
        }

        // Clear the frontend canvas
        excalidrawAPI.updateScene({
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      } catch (error) {
        console.error("Error clearing canvas:", error);
        // Still clear frontend even if backend fails
        excalidrawAPI.updateScene({
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      }
    }
  };

  return (
    <div className="app">
      <div className="studio-shell">
        <div className="shell-glow shell-glow-left" aria-hidden="true"></div>
        <div className="shell-glow shell-glow-right" aria-hidden="true"></div>

        <div className="header">
          <div className="brand-block">
            <h1>Claude Monet</h1>
          </div>

          <div className="controls">
            <div className="status status-pill">
              <div
                className={`status-dot ${isConnected ? "status-connected" : "status-disconnected"}`}
              ></div>
              <span>{isConnected ? "Live Connection" : "Reconnecting..."}</span>
            </div>

            <div className="sync-controls studio-actions">
              <button className="btn-secondary btn-pill" onClick={clearCanvas}>
                Clear Canvas
              </button>
            </div>

            <button
              className={`mic-toggle-fab${isListening ? ' listening' : ''}`}
              type="button"
              aria-label="Toggle microphone"
              onClick={isSpeaking ? stopSpeaking : toggleListening}
              disabled={!hasSpeech}
              title={hasSpeech ? (isSpeaking ? 'Stop speaking' : isListening ? 'Mic on — click to stop (M)' : 'Click to start mic (M)') : 'Speech not supported in this browser'}
            >
              <span className="mic-toggle-label">
                {isSpeaking ? 'Speaking… ⏹' : isListening ? (liveTranscript || 'Listening…') : 'Ask Claude'}
              </span>
              <span className="mic-switch" aria-hidden="true">
                <span className="mic-switch-thumb"></span>
              </span>
            </button>
          </div>
        </div>
      </div>

      <div className="main-content">
        <div className="canvas-container">
          <Excalidraw
            excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
            onChange={handleCanvasChange}
            initialData={{
              elements: [],
              appState: {
                theme: "light",
                viewBackgroundColor: "#ffffff",
              },
            }}
          />
        </div>

        <div className="chat-sidebar">
          <div className="chat-sidebar-header">
            <span>Chat</span>
            {chatHistory.length > 0 && (
              <button className="chat-clear-btn" onClick={() => setChatHistory([])}>Clear</button>
            )}
          </div>
          <div className="chat-messages">
            {chatHistory.length === 0 && !liveTranscript && (
              <p className="chat-empty">Voice messages will appear here.</p>
            )}
            {chatHistory.map((msg) => (
              <div key={msg.ts} className={`chat-msg chat-msg-${msg.role}`}>
                <span className="chat-msg-role">{msg.role === 'user' ? 'You' : 'Claude'}</span>
                <p className="chat-msg-text">{msg.text}</p>
              </div>
            ))}
            {liveTranscript && (
              <div className="chat-msg chat-msg-live">
                <span className="chat-msg-role">You</span>
                <p className="chat-msg-text chat-msg-text-live">{liveTranscript}</p>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
