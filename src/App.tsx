import { useEffect, useMemo, useRef, useState } from 'react';
import emailjs from '@emailjs/browser';

type Step = 'template' | 'pose' | 'capture' | 'design' | 'download';

type Capture = {
  id: string;
  src: string;
};

type CameraSelection = {
  stream: MediaStream;
  usingBackCamera: boolean;
  selectedDeviceId?: string;
};

type FrameBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type TemplateSize = {
  width: number;
  height: number;
};

type StickerAsset = {
  path: string;
  src: string;
  label: string;
  folder: string;
};

type DesignTool = 'select' | 'draw';

type DesignElementBase = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
};

type DesignStickerElement = DesignElementBase & {
  kind: 'sticker';
  stickerSrc: string;
  stickerLabel: string;
};

type DoodlePoint = {
  nx: number;
  ny: number;
};

type DesignDoodleElement = DesignElementBase & {
  kind: 'doodle';
  points: DoodlePoint[];
  color: string;
  strokeWidth: number;
};

type DesignElement = DesignStickerElement | DesignDoodleElement;

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type DragState = {
  kind: 'move' | 'resize' | 'rotate';
  elementId: string;
  startX: number;
  startY: number;
  startRect: FrameBox;
  startRotation: number;
  startAngle?: number;
  resizeCorner?: ResizeCorner;
  startStrokeWidth?: number;
  elementKind?: 'sticker' | 'doodle';
};

type Point = {
  x: number;
  y: number;
};

const NO_POSE_REFERENCE = '__NO_POSE_REFERENCE__';

const DEFAULT_TEMPLATE_WIDTH = 707;
const DEFAULT_TEMPLATE_HEIGHT = 2000;

const DESIGN_ZOOM_MIN = 0.35;
const DESIGN_ZOOM_MAX = 2.75;
const DESIGN_ZOOM_STEP = 1.15;
/** How far stickers/doodles may extend past the template edge (ratio of longer template side). */
const DESIGN_BOUNDS_PAD_RATIO = 0.35;

const STICKER_FOLDER_PREVIEW_COUNT = 3;

const templateOptions = Object.entries(
  import.meta.glob('./template/*.{png,jpg,jpeg,webp,avif}', {
    eager: true,
    import: 'default',
  }),
).map(([path, src]) => ({
  path,
  src: String(src),
  label: path.split('/').pop()?.replace(/\.[^/.]+$/, '') ?? 'Template',
}));

const poseReferenceOptions = Object.entries(
  import.meta.glob('./pose_reference/*.{png,jpg,jpeg,webp,avif}', {
    eager: true,
    import: 'default',
  }),
).map(([path, src]) => ({
  path,
  src: String(src),
  label: path.split('/').pop()?.replace(/\.[^/.]+$/, '') ?? 'Pose',
}));

const stickerAssets = Object.entries(
  import.meta.glob('./stickers/**/*.{png,jpg,jpeg,webp,avif,gif}', {
    eager: true,
    import: 'default',
  }),
).map(([path, src]) => {
  const parts = path.split('/').filter(Boolean);
  const folder = parts[2] ?? 'stickers';
  return {
    path,
    src: String(src),
    label: path.split('/').pop()?.replace(/\.[^/.]+$/, '') ?? 'Sticker',
    folder,
  } satisfies StickerAsset;
});

const stickerFolders = [...new Set(stickerAssets.map((asset) => asset.folder))].sort((a, b) => a.localeCompare(b));

const DOODLE_PALETTE = ['#ffffff', '#ff4d9d', '#ffcc4d', '#7ef0ff', '#a78bfa', '#56f39a'] as const;

// Fallback frame positions in original template pixel space (707x2000).
const DEFAULT_FRAME_POSITIONS: FrameBox[] = [
  { x: 121, y: 161, w: 465, h: 300 },   // Top rectangle cutout
  { x: 94, y: 519, w: 519, h: 363 },    // Second cloud cutout
  { x: 120, y: 942, w: 466, h: 299 },   // Third rectangle cutout
  { x: 93, y: 1304, w: 505, h: 361 },   // Bottom cloud cutout
];

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sideVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const designWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recorderRafRef = useRef<number | null>(null);
  const recorderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const templateImageRef = useRef<HTMLImageElement | null>(null);
  const templateSizeRef = useRef<TemplateSize>({ width: DEFAULT_TEMPLATE_WIDTH, height: DEFAULT_TEMPLATE_HEIGHT });
  const capturesRef = useRef<Capture[]>([]);
  const framePositionsRef = useRef<FrameBox[]>(DEFAULT_FRAME_POSITIONS);
  const captureImageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const stickerImageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const dragStateRef = useRef<DragState | null>(null);
  const drawPointsRef = useRef<Point[]>([]);
  const drawingPointerIdRef = useRef<number | null>(null);
  const isDrawingDoodleRef = useRef(false);
  const flashTimeoutRef = useRef<number | null>(null);
  const [step, setStep] = useState<Step>('template');
  const [selectedTemplateSrc, setSelectedTemplateSrc] = useState<string>(templateOptions[0]?.src ?? '');
  const [selectedPoseSrc, setSelectedPoseSrc] = useState<string>(poseReferenceOptions[0]?.src ?? '');
  const [countdown, setCountdown] = useState(0);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [isAutoCapturing, setIsAutoCapturing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [templateSize, setTemplateSize] = useState<TemplateSize>({
    width: DEFAULT_TEMPLATE_WIDTH,
    height: DEFAULT_TEMPLATE_HEIGHT,
  });
  const [framePositions, setFramePositions] = useState<FrameBox[]>(DEFAULT_FRAME_POSITIONS);
  const [sessionVideoUrl, setSessionVideoUrl] = useState<string | null>(null);
  const [emailAddress, setEmailAddress] = useState('');
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [sendMessage, setSendMessage] = useState('');
  const [isFlashing, setIsFlashing] = useState(false);
  const [designElements, setDesignElements] = useState<DesignElement[]>([]);
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null);
  const [activeDesignTool, setActiveDesignTool] = useState<DesignTool>('select');
  const [activeStickerFolder, setActiveStickerFolder] = useState<string>(stickerFolders[0] ?? 'stickers');
  const [stickerBrowserOpen, setStickerBrowserOpen] = useState(false);
  const [doodleColor, setDoodleColor] = useState('#ff4d9d');
  const [doodleStrokeWidth, setDoodleStrokeWidth] = useState(10);
  const [isDrawingDoodle, setIsDrawingDoodle] = useState(false);
  const [draftDoodlePoints, setDraftDoodlePoints] = useState<Point[]>([]);
  const [designPointerCursor, setDesignPointerCursor] = useState<string>('default');
  const [designStageZoom, setDesignStageZoom] = useState(1);

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current);
        flashTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (step !== 'design') {
      setDesignStageZoom(1);
      setStickerBrowserOpen(false);
    }
  }, [step]);

  useEffect(() => {
    if (!stickerBrowserOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setStickerBrowserOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stickerBrowserOpen]);

  useEffect(() => {
    isDrawingDoodleRef.current = isDrawingDoodle;
  }, [isDrawingDoodle]);

  useEffect(() => {
    let canceled = false;

    async function resolveTemplateFrames() {
      try {
        if (!selectedTemplateSrc) return;
        const template = await loadImage(selectedTemplateSrc);
        templateImageRef.current = template;
        const nextTemplateSize = { width: template.naturalWidth, height: template.naturalHeight };
        if (!canceled) {
          setTemplateSize(nextTemplateSize);
        }
        const detectedFrames = detectTransparentFrames(template);
        if (!canceled && detectedFrames.length === 4) {
          setFramePositions(detectedFrames);
        } else if (!canceled) {
          setFramePositions(getTemplateFallbackFrames(selectedTemplateSrc, nextTemplateSize));
        }
      } catch {
        if (!canceled) {
          setFramePositions(getTemplateFallbackFrames(selectedTemplateSrc, templateSizeRef.current));
        }
      }
    }

    void resolveTemplateFrames();
    return () => {
      canceled = true;
    };
  }, [selectedTemplateSrc]);

  useEffect(() => {
    capturesRef.current = captures;
  }, [captures]);

  useEffect(() => {
    framePositionsRef.current = framePositions;
  }, [framePositions]);

  useEffect(() => {
    templateSizeRef.current = templateSize;
  }, [templateSize]);

  useEffect(() => {
    const cache = captureImageCacheRef.current;
    const ids = new Set(captures.map((capture) => capture.id));

    for (const shot of captures) {
      if (!cache.has(shot.id)) {
        const image = new Image();
        image.src = shot.src;
        cache.set(shot.id, image);
      }
    }

    for (const id of [...cache.keys()]) {
      if (!ids.has(id)) {
        cache.delete(id);
      }
    }
  }, [captures]);

  useEffect(() => {
    const cache = stickerImageCacheRef.current;
    const ids = new Set(designElements.filter((element) => element.kind === 'sticker').map((element) => element.stickerSrc));

    for (const element of designElements) {
      if (element.kind === 'sticker' && !cache.has(element.stickerSrc)) {
        const image = new Image();
        image.src = element.stickerSrc;
        cache.set(element.stickerSrc, image);
      }
    }

    for (const [src] of [...cache.entries()]) {
      if (!ids.has(src)) {
        cache.delete(src);
      }
    }
  }, [designElements]);

  useEffect(() => {
    if (stickerFolders.length > 0 && !stickerFolders.includes(activeStickerFolder)) {
      setActiveStickerFolder(stickerFolders[0]);
    }
  }, [activeStickerFolder]);

  const stickersInActiveFolder = useMemo(
    () => stickerAssets.filter((asset) => asset.folder === activeStickerFolder),
    [activeStickerFolder],
  );

  const previewStickersInFolder = stickersInActiveFolder.slice(0, STICKER_FOLDER_PREVIEW_COUNT);

  // Camera setup
  useEffect(() => {
    let stream: MediaStream | null = null;
    let canceled = false;

    async function startCamera() {
      try {
        setCameraReady(false);
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('This browser does not support webcam access.');
        }

        const selected = await getPreferredCameraStream(activeDeviceId);
        stream = selected.stream;
        cameraStreamRef.current = stream;

        if (canceled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (sideVideoRef.current) {
          sideVideoRef.current.srcObject = stream;
          await sideVideoRef.current.play();
        }

        const trackDeviceId = selected.selectedDeviceId ?? stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (trackDeviceId && trackDeviceId !== activeDeviceId) {
          setActiveDeviceId(trackDeviceId);
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        setVideoInputs(devices.filter((device) => device.kind === 'videoinput'));

        setCameraReady(true);
        setCameraError(null);
      } catch (error) {
        setCameraError(error instanceof Error ? error.message : 'Unable to open the camera.');
        setCameraReady(false);
      }
    }

    void startCamera();

    return () => {
      canceled = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (cameraStreamRef.current === stream) {
        cameraStreamRef.current = null;
      }
    };
  }, [activeDeviceId]);

  // Re-bind stream when capture UI remounts (e.g., Back to Camera) to avoid black screen.
  useEffect(() => {
    if (step !== 'capture') return;

    const stream = cameraStreamRef.current;
    if (!stream) return;

    async function attach() {
      try {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (sideVideoRef.current) {
          sideVideoRef.current.srcObject = stream;
          await sideVideoRef.current.play();
        }
      } catch {
        // Camera setup effect will recover stream binding if needed.
      }
    }

    void attach();
  }, [step]);

  // Countdown timer - auto-capture until all 4 photos are captured
  useEffect(() => {
    if (!isAutoCapturing || countdown <= 0) return;

    const timer = setTimeout(() => {
      if (countdown === 1) {
        const willCompleteSession = captures.length + 1 >= framePositions.length;
        captureFrame();

        if (willCompleteSession) {
          setIsAutoCapturing(false);
          setCountdown(0);
          stopSessionRecording();
        } else {
          setCountdown(5);
        }
      } else {
        setCountdown((current) => current - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown, isAutoCapturing, captures.length, framePositions.length]);

  useEffect(() => {
    if (captures.length >= 4) {
      setTimeout(() => setStep('design'), 500);
    }
  }, [captures.length]);

  function startCountdown() {
    if (captures.length >= 4) return;
    setIsAutoCapturing(true);
    startSessionRecording();
    setCountdown(5);
  }

  function startSessionRecording() {
    const sourceVideo = videoRef.current;
    if (!sourceVideo || sourceVideo.readyState < 2) return;
    if (recorderRef.current && recorderRef.current.state === 'recording') return;

    if (sessionVideoUrl) {
      URL.revokeObjectURL(sessionVideoUrl);
      setSessionVideoUrl(null);
    }

    const templateImage = templateImageRef.current;
    if (!templateImage) return;

    const recorderCanvas = document.createElement('canvas');
    recorderCanvas.width = templateSize.width;
    recorderCanvas.height = templateSize.height;
    const recorderContext = recorderCanvas.getContext('2d');
    if (!recorderContext) return;

    recorderCanvasRef.current = recorderCanvas;

    const drawStripFrame = () => {
      const frames = framePositionsRef.current;
      const shots = capturesRef.current;
      const size = templateSizeRef.current;
      recorderContext.clearRect(0, 0, size.width, size.height);

      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const shot = shots[i];
        if (shot) {
          const cached = captureImageCacheRef.current.get(shot.id);
          if (cached && cached.complete) {
            drawImageCover(recorderContext, cached, frame.x, frame.y, frame.w, frame.h);
          }
        }
      }

      const liveIndex = shots.length;
      if (liveIndex < frames.length && sourceVideo.readyState >= 2) {
        const liveFrame = frames[liveIndex];
        drawVideoCoverAt(recorderContext, sourceVideo, liveFrame.x, liveFrame.y, liveFrame.w, liveFrame.h, true);
      }

      recorderContext.drawImage(templateImage, 0, 0, size.width, size.height);
      recorderRafRef.current = requestAnimationFrame(drawStripFrame);
    };

    drawStripFrame();

    const stream = recorderCanvas.captureStream(30);
    recorderStreamRef.current = stream;

    const preferredMimeTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const supportedMimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));

    const recorder = supportedMimeType
      ? new MediaRecorder(stream, { mimeType: supportedMimeType })
      : new MediaRecorder(stream);

    recorderChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recorderChunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      if (recorderRafRef.current !== null) {
        cancelAnimationFrame(recorderRafRef.current);
        recorderRafRef.current = null;
      }
      recorderCanvasRef.current = null;
      if (recorderChunksRef.current.length === 0) return;
      const blob = new Blob(recorderChunksRef.current, { type: recorder.mimeType || 'video/webm' });
      const nextUrl = URL.createObjectURL(blob);
      setSessionVideoUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return nextUrl;
      });
    };

    recorderRef.current = recorder;
    recorder.start();
  }

  function stopSessionRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }

    if (recorderStreamRef.current) {
      recorderStreamRef.current.getTracks().forEach((track) => track.stop());
      recorderStreamRef.current = null;
    }

    if (recorderRafRef.current !== null) {
      cancelAnimationFrame(recorderRafRef.current);
      recorderRafRef.current = null;
    }
  }

  function switchCamera() {
    if (videoInputs.length < 2) return;
    const currentIndex = videoInputs.findIndex((device) => device.deviceId === activeDeviceId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % videoInputs.length : 0;
    setIsAutoCapturing(false);
    setCountdown(0);
    stopSessionRecording();
    setActiveDeviceId(videoInputs[nextIndex].deviceId);
  }

  function captureFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || video.readyState < 2) {
      return captures.length;
    }

    const frameIndex = Math.min(captures.length, framePositions.length - 1);
    const targetFrame = framePositions[frameIndex];
    canvas.width = targetFrame.w;
    canvas.height = targetFrame.h;

    const context = canvas.getContext('2d');
    if (!context) {
      return captures.length;
    }

    drawVideoCover(context, video, targetFrame.w, targetFrame.h, true);
    const src = canvas.toDataURL('image/png');

    setIsFlashing(true);
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }
    flashTimeoutRef.current = window.setTimeout(() => {
      setIsFlashing(false);
      flashTimeoutRef.current = null;
    }, 110);

    let nextLength = captures.length;
    setCaptures((current) => {
      const next = [...current, { id: crypto.randomUUID(), src }].slice(0, 4);
      nextLength = next.length;
      return next;
    });

    return nextLength;
  }

  function stopCaptureAndRecording() {
    stopSessionRecording();
    setCaptures([]);
    setCountdown(0);
    setIsAutoCapturing(false);
    setIsFlashing(false);
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = null;
    }
    setSessionVideoUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }

  function resetDesignEditorState() {
    setDesignElements([]);
    setSelectedDesignId(null);
    setActiveDesignTool('select');
    setDraftDoodlePoints([]);
    setIsDrawingDoodle(false);
  }

  /** Fresh capture run: empty slots in the strip, no countdown, no session recording. */
  function goBackToCameraFromDesign() {
    stopCaptureAndRecording();
    resetDesignEditorState();
    setStep('capture');
  }

  function resetPhotobooth() {
    stopCaptureAndRecording();
    resetDesignEditorState();
    setEmailAddress('');
    setSendState('idle');
    setSendMessage('');
    setStep('capture');
  }

  const activeFrameIndex = Math.min(captures.length, framePositions.length - 1);
  const activeFrame = framePositions[activeFrameIndex];

  const selectedDesignElement = designElements.find((element) => element.id === selectedDesignId) ?? null;
  const penPaletteActiveColor =
    selectedDesignElement?.kind === 'doodle' ? selectedDesignElement.color : doodleColor;

  function clampValue(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
  }

  function getDesignPointFromEvent(event: React.PointerEvent<HTMLDivElement>) {
    const workspace = designWorkspaceRef.current;
    if (!workspace) return null;

    const bounds = workspace.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;

    const x = ((event.clientX - bounds.left) / bounds.width) * templateSize.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * templateSize.height;

    return {
      x: clampValue(x, 0, templateSize.width),
      y: clampValue(y, 0, templateSize.height),
    } satisfies Point;
  }

  function getDesignPointFromClientPoint(clientX: number, clientY: number) {
    const workspace = designWorkspaceRef.current;
    if (!workspace) return null;

    const bounds = workspace.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;

    const x = ((clientX - bounds.left) / bounds.width) * templateSize.width;
    const y = ((clientY - bounds.top) / bounds.height) * templateSize.height;

    return {
      x: clampValue(x, 0, templateSize.width),
      y: clampValue(y, 0, templateSize.height),
    } satisfies Point;
  }

  function getElementById(elementId: string) {
    return designElements.find((element) => element.id === elementId) ?? null;
  }

  function updateElementRect(elementId: string, rect: FrameBox) {
    setDesignElements((current) =>
      current.map((element) => (element.id === elementId ? { ...element, ...rect } : element)),
    );
  }

  function updateElementRotation(elementId: string, rotation: number) {
    setDesignElements((current) =>
      current.map((element) => (element.id === elementId ? { ...element, rotation } : element)),
    );
  }

  function updateElementRectAndStroke(elementId: string, rect: FrameBox, strokeWidth?: number) {
    setDesignElements((current) =>
      current.map((element) => {
        if (element.id !== elementId) return element;
        if (element.kind === 'doodle' && strokeWidth !== undefined) {
          return { ...element, ...rect, strokeWidth };
        }
        return { ...element, ...rect };
      }),
    );
  }

  function clientDeltaToTemplateDelta(dxClient: number, dyClient: number) {
    const workspace = designWorkspaceRef.current;
    if (!workspace) return { dxt: 0, dyt: 0 };
    const bounds = workspace.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return { dxt: 0, dyt: 0 };
    return {
      dxt: (dxClient / bounds.width) * templateSize.width,
      dyt: (dyClient / bounds.height) * templateSize.height,
    };
  }

  function getDesignCanvasBoundsPad() {
    return Math.max(templateSize.width, templateSize.height) * DESIGN_BOUNDS_PAD_RATIO;
  }

  function bringDesignElementToFront(elementId: string) {
    setDesignElements((current) => {
      const i = current.findIndex((e) => e.id === elementId);
      if (i < 0 || i === current.length - 1) return current;
      const next = [...current];
      const [el] = next.splice(i, 1);
      next.push(el);
      return next;
    });
  }

  function computeCornerResize(
    corner: ResizeCorner,
    start: FrameBox,
    dxt: number,
    dyt: number,
    templateW: number,
    templateH: number,
    pad: number,
  ): FrameBox {
    const minSize = 36;

    if (corner === 'se') {
      w = clampValue(start.w + dxt, minSize, templateW + pad - start.x);
      h = clampValue(start.h + dyt, minSize, templateH + pad - start.y);
      return { x: start.x, y: start.y, w, h };
    }

    if (corner === 'nw') {
      let nextX = start.x + dxt;
      let nextY = start.y + dyt;
      let nextW = start.w - dxt;
      let nextH = start.h - dyt;
      if (nextW < minSize) {
        nextX = start.x + start.w - minSize;
        nextW = minSize;
      }
      if (nextH < minSize) {
        nextY = start.y + start.h - minSize;
        nextH = minSize;
      }
      nextX = clampValue(nextX, -pad, start.x + start.w - minSize);
      nextY = clampValue(nextY, -pad, start.y + start.h - minSize);
      nextW = start.x + start.w - nextX;
      nextH = start.y + start.h - nextY;
      return { x: nextX, y: nextY, w: nextW, h: nextH };
    }

    if (corner === 'ne') {
      let nextY = start.y + dyt;
      let nextH = start.h - dyt;
      let nextW = start.w + dxt;
      if (nextH < minSize) {
        nextY = start.y + start.h - minSize;
        nextH = minSize;
      }
      nextY = clampValue(nextY, -pad, start.y + start.h - minSize);
      nextH = start.y + start.h - nextY;
      nextW = clampValue(nextW, minSize, templateW + pad - start.x);
      return { x: start.x, y: nextY, w: nextW, h: nextH };
    }

    // sw
    let nextX = start.x + dxt;
    let nextW = start.w - dxt;
    let nextH = start.h + dyt;
    if (nextW < minSize) {
      nextX = start.x + start.w - minSize;
      nextW = minSize;
    }
    nextX = clampValue(nextX, -pad, start.x + start.w - minSize);
    nextW = start.x + start.w - nextX;
    nextH = clampValue(nextH, minSize, templateH + pad - start.y);
    return { x: nextX, y: start.y, w: nextW, h: nextH };
  }

  function getElementCenter(rect: FrameBox) {
    return {
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
    };
  }

  function getPointerAngle(event: PointerEvent, rect: FrameBox) {
    const workspace = designWorkspaceRef.current;
    if (!workspace) return 0;

    const bounds = workspace.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * templateSize.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * templateSize.height;
    const center = getElementCenter(rect);

    return (Math.atan2(y - center.y, x - center.x) * 180) / Math.PI;
  }

  async function addStickerToCanvas(asset: StickerAsset) {
    const image = await loadImage(asset.src);
    const baseWidth = Math.min(templateSize.width * 0.24, 220);
    const ratio = image.naturalWidth / Math.max(image.naturalHeight, 1);
    const width = clampValue(baseWidth, 90, templateSize.width * 0.45);
    const height = clampValue(width / Math.max(ratio, 0.1), 90, templateSize.height * 0.45);
    const nextX = (templateSize.width - width) / 2;
    const nextY = (templateSize.height - height) / 2;

    const nextElement: DesignStickerElement = {
      id: crypto.randomUUID(),
      kind: 'sticker',
      x: nextX,
      y: nextY,
      w: width,
      h: height,
      rotation: 0,
      stickerSrc: asset.src,
      stickerLabel: asset.label,
    };

    setDesignElements((current) => [...current, nextElement]);
    setSelectedDesignId(nextElement.id);
    setActiveDesignTool('select');
  }

  function createDoodleGeometry(points: Point[]) {
    if (points.length < 2) return null;

    let minX = points[0].x;
    let maxX = points[0].x;
    let minY = points[0].y;
    let maxY = points[0].y;

    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    const padding = 18;
    const boxWidth = Math.max(maxX - minX, 1);
    const boxHeight = Math.max(maxY - minY, 1);
    const left = clampValue(minX - padding, 0, templateSize.width - 1);
    const top = clampValue(minY - padding, 0, templateSize.height - 1);
    const width = clampValue(boxWidth + padding * 2, 24, templateSize.width - left);
    const height = clampValue(boxHeight + padding * 2, 24, templateSize.height - top);

    return {
      x: left,
      y: top,
      w: width,
      h: height,
      points: points.map((point) => ({ x: point.x, y: point.y })),
    };
  }

  function startDoodleStroke(event: React.PointerEvent<HTMLDivElement>) {
    const point = getDesignPointFromEvent(event);
    if (!point) return;

    drawingPointerIdRef.current = event.pointerId;
    setIsDrawingDoodle(true);
    setDraftDoodlePoints([point]);
    drawPointsRef.current = [point];
    setSelectedDesignId(null);
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some targets may not support capture; window pointer listeners still work.
    }
  }

  function updateDoodleStroke(clientX: number, clientY: number) {
    if (!isDrawingDoodleRef.current) return;
    const point = getDesignPointFromClientPoint(clientX, clientY);
    if (!point) return;

    drawPointsRef.current = [...drawPointsRef.current, point];
    setDraftDoodlePoints(drawPointsRef.current);
  }

  function finishDoodleStroke() {
    if (!isDrawingDoodleRef.current) return;

    const doodle = createDoodleGeometry(drawPointsRef.current);
    setIsDrawingDoodle(false);
    setDraftDoodlePoints([]);
    const endedPointerId = drawingPointerIdRef.current;
    drawPointsRef.current = [];
    drawingPointerIdRef.current = null;

    const stage = designWorkspaceRef.current;
    if (stage && endedPointerId !== null) {
      try {
        stage.releasePointerCapture(endedPointerId);
      } catch {
        // Ignore if capture was already released.
      }
    }

    if (!doodle) return;

    const denomW = Math.max(doodle.w, 1e-6);
    const denomH = Math.max(doodle.h, 1e-6);
    const normalizedPoints: DoodlePoint[] = doodle.points.map((point) => ({
      nx: (point.x - doodle.x) / denomW,
      ny: (point.y - doodle.y) / denomH,
    }));

    const nextElement: DesignDoodleElement = {
      id: crypto.randomUUID(),
      kind: 'doodle',
      x: doodle.x,
      y: doodle.y,
      w: doodle.w,
      h: doodle.h,
      rotation: 0,
      points: normalizedPoints,
      color: doodleColor,
      strokeWidth: doodleStrokeWidth,
    };

    setDesignElements((current) => [...current, nextElement]);
    setSelectedDesignId(nextElement.id);
  }

  function beginElementDrag(event: React.PointerEvent<HTMLDivElement>, elementId: string) {
    const element = getElementById(elementId);
    if (!element || activeDesignTool === 'draw') return;

    bringDesignElementToFront(elementId);
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      kind: 'move',
      elementId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: { x: element.x, y: element.y, w: element.w, h: element.h },
      startRotation: element.rotation,
    };
    setSelectedDesignId(elementId);
    setDesignPointerCursor('grabbing');
  }

  function beginElementResize(event: React.PointerEvent<HTMLButtonElement>, elementId: string, corner: ResizeCorner) {
    event.stopPropagation();
    const element = getElementById(elementId);
    if (!element) return;

    bringDesignElementToFront(elementId);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      kind: 'resize',
      elementId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: { x: element.x, y: element.y, w: element.w, h: element.h },
      startRotation: element.rotation,
      resizeCorner: corner,
      elementKind: element.kind,
      startStrokeWidth: element.kind === 'doodle' ? element.strokeWidth : undefined,
    };
    setSelectedDesignId(elementId);
    const cursors: Record<ResizeCorner, string> = {
      nw: 'nwse-resize',
      se: 'nwse-resize',
      ne: 'nesw-resize',
      sw: 'nesw-resize',
    };
    setDesignPointerCursor(cursors[corner]);
  }

  function beginElementRotate(event: React.PointerEvent<HTMLButtonElement>, elementId: string) {
    event.stopPropagation();
    const element = getElementById(elementId);
    if (!element) return;

    bringDesignElementToFront(elementId);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      kind: 'rotate',
      elementId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: { x: element.x, y: element.y, w: element.w, h: element.h },
      startRotation: element.rotation,
      startAngle: getPointerAngle(event.nativeEvent, { x: element.x, y: element.y, w: element.w, h: element.h }),
    };
    setSelectedDesignId(elementId);
    setDesignPointerCursor('grab');
  }

  function clearSelectedElement() {
    setSelectedDesignId(null);
  }

  function deleteSelectedElement() {
    if (!selectedDesignId) return;
    setDesignElements((current) => current.filter((element) => element.id !== selectedDesignId));
    setSelectedDesignId(null);
  }

  function updateSelectedDoodleColor(color: string) {
    setDoodleColor(color);
    if (!selectedDesignElement || selectedDesignElement.kind !== 'doodle') return;

    setDesignElements((current) =>
      current.map((element) =>
        element.id === selectedDesignId ? { ...element, color } : element,
      ),
    );
  }

  function updateSelectedDoodleStrokeWidth(nextWidth: number) {
    setDoodleStrokeWidth(nextWidth);
    if (!selectedDesignElement || selectedDesignElement.kind !== 'doodle') return;

    setDesignElements((current) =>
      current.map((element) =>
        element.id === selectedDesignId ? { ...element, strokeWidth: nextWidth } : element,
      ),
    );
  }

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (
        activeDesignTool === 'draw' &&
        isDrawingDoodleRef.current &&
        drawingPointerIdRef.current === event.pointerId
      ) {
        updateDoodleStroke(event.clientX, event.clientY);
        return;
      }

      const dragState = dragStateRef.current;
      if (dragState) {
        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;
        const { dxt, dyt } = clientDeltaToTemplateDelta(dx, dy);

        if (dragState.kind === 'move') {
          const pad = getDesignCanvasBoundsPad();
          updateElementRect(dragState.elementId, {
            x: clampValue(dragState.startRect.x + dxt, -pad, templateSize.width - dragState.startRect.w + pad),
            y: clampValue(dragState.startRect.y + dyt, -pad, templateSize.height - dragState.startRect.h + pad),
            w: dragState.startRect.w,
            h: dragState.startRect.h,
          });
        } else if (dragState.kind === 'resize') {
          const corner = dragState.resizeCorner ?? 'se';
          const nextRect = computeCornerResize(
            corner,
            dragState.startRect,
            dxt,
            dyt,
            templateSize.width,
            templateSize.height,
            getDesignCanvasBoundsPad(),
          );
          if (dragState.elementKind === 'doodle' && dragState.startStrokeWidth !== undefined) {
            const scaleW = nextRect.w / Math.max(dragState.startRect.w, 1e-6);
            const scaleH = nextRect.h / Math.max(dragState.startRect.h, 1e-6);
            const scale = Math.sqrt(Math.max(scaleW * scaleH, 1e-6));
            const nextStroke = clampValue(dragState.startStrokeWidth * scale, 2, 80);
            updateElementRectAndStroke(dragState.elementId, nextRect, nextStroke);
          } else {
            updateElementRect(dragState.elementId, nextRect);
          }
        } else if (dragState.kind === 'rotate') {
          const pointerAngle = getPointerAngle(event, dragState.startRect);
          const angleDelta = dragState.startAngle !== undefined ? pointerAngle - dragState.startAngle : 0;
          updateElementRotation(dragState.elementId, dragState.startRotation + angleDelta);
        }
      }
    }

    function handlePointerUp() {
      if (isDrawingDoodleRef.current) {
        finishDoodleStroke();
        return;
      }

      if (dragStateRef.current) {
        dragStateRef.current = null;
        setDesignPointerCursor('default');
      }
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [
    isDrawingDoodle,
    templateSize.width,
    templateSize.height,
    activeDesignTool,
    doodleColor,
    doodleStrokeWidth,
  ]);

  useEffect(() => {
    if (step !== 'design') return;

    function handleDesignKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (!selectedDesignId) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      setDesignElements((current) => current.filter((element) => element.id !== selectedDesignId));
      setSelectedDesignId(null);
    }

    window.addEventListener('keydown', handleDesignKeyDown);
    return () => window.removeEventListener('keydown', handleDesignKeyDown);
  }, [step, selectedDesignId]);

  async function generateStripDataUrl() {
    if (captures.length === 0 || !selectedTemplateSrc) return;

    const template = await loadImage(selectedTemplateSrc);
    const canvas = document.createElement('canvas');
    canvas.width = templateSize.width;
    canvas.height = templateSize.height;
    const context = canvas.getContext('2d');

    if (!context) return;

    // Draw photos first so the template frame sits in front (cover = same as capture preview / object-fit: cover).
    for (let i = 0; i < framePositions.length; i++) {
      if (captures[i]) {
        const photo = await loadImage(captures[i].src);
        const frame = framePositions[i];
        drawImageCover(context, photo, frame.x, frame.y, frame.w, frame.h);
      }
    }

    // Scale template to the output canvas so holes line up with framePositions (natural-size draw can mis-register).
    context.drawImage(template, 0, 0, canvas.width, canvas.height);

    for (const element of designElements) {
      if (element.kind === 'sticker') {
        const cached = stickerImageCacheRef.current.get(element.stickerSrc) ?? (await loadImage(element.stickerSrc));
        if (!stickerImageCacheRef.current.has(element.stickerSrc)) {
          stickerImageCacheRef.current.set(element.stickerSrc, cached);
        }
        drawRotatedContainImage(context, cached, element.x, element.y, element.w, element.h, element.rotation);
      } else {
        drawDoodleOnCanvas(context, element.points, { x: element.x, y: element.y, w: element.w, h: element.h }, element.rotation, element.color, element.strokeWidth);
      }
    }

    return canvas.toDataURL('image/png');
  }

  async function downloadCard() {
    const dataUrl = await generateStripDataUrl();
    if (!dataUrl) return;

    const link = document.createElement('a');
    link.download = `photobooth-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
  }

  async function sendToEmail() {
    const trimmedEmail = emailAddress.trim();
    if (!trimmedEmail) {
      setSendState('error');
      setSendMessage('Please enter an email address.');
      return;
    }

    setSendState('sending');
    setSendMessage('Sending your photostrip...');

    try {
      const dataUrl = await generateStripDataUrl();
      if (!dataUrl) {
        throw new Error('Unable to generate photostrip image.');
      }

      const emailJsServiceId = import.meta.env.VITE_EMAILJS_SERVICE_ID as string | undefined;
      const emailJsTemplateId = import.meta.env.VITE_EMAILJS_TEMPLATE_ID as string | undefined;
      const emailJsPublicKey = import.meta.env.VITE_EMAILJS_PUBLIC_KEY as string | undefined;

      if (emailJsServiceId && emailJsTemplateId && emailJsPublicKey) {
        await emailjs.send(
          emailJsServiceId,
          emailJsTemplateId,
          {
            to_email: trimmedEmail,
            strip_image_data_url: dataUrl,
            app_name: 'CozyCam',
          },
          {
            publicKey: emailJsPublicKey,
          },
        );
      } else {
        const response = await fetch('/api/send-strip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: trimmedEmail,
            imageDataUrl: dataUrl,
          }),
        });

        const payload = (await response.json()) as { message?: string };
        if (!response.ok) {
          throw new Error(payload.message ?? 'Failed to send email.');
        }
      }

      setSendState('success');
      setSendMessage('Photostrip sent successfully.');
    } catch (error) {
      setSendState('error');
      setSendMessage(error instanceof Error ? error.message : 'Failed to send email.');
    }
  }

  return (
    <main className="app-shell">
      <canvas ref={canvasRef} className="sr-only" aria-hidden="true" />

      {/* STEP 0: TEMPLATE SELECT */}
      {step === 'template' && (
        <section className="step-section step-setup">
          <div className="step-header">
            <h1>Choose Template</h1>
            <p>Select a photostrip template to continue</p>
          </div>

          <div className="setup-grid">
            {templateOptions.map((template) => (
              <button
                key={template.path}
                className={`setup-card ${selectedTemplateSrc === template.src ? 'selected' : ''}`}
                onClick={() => setSelectedTemplateSrc(template.src)}
              >
                <img src={template.src} alt={template.label} className="setup-card-image" />
                <span>{template.label}</span>
              </button>
            ))}
          </div>

          <div className="step-actions">
            <button className="primary-button" onClick={() => setStep('pose')} disabled={!selectedTemplateSrc}>
              Continue to Pose →
            </button>
          </div>
        </section>
      )}

      {/* STEP 0.5: POSE SELECT */}
      {step === 'pose' && (
        <section className="step-section step-setup">
          <div className="step-header">
            <h1>Choose Pose Reference</h1>
            <p>Select a pose guide or continue without one</p>
          </div>

          <div className="setup-grid setup-grid-poses">
            <button
              key={NO_POSE_REFERENCE}
              className={`setup-card ${selectedPoseSrc === NO_POSE_REFERENCE ? 'selected' : ''}`}
              onClick={() => setSelectedPoseSrc(NO_POSE_REFERENCE)}
            >
              <div className="setup-card-image setup-card-image-placeholder">No reference</div>
              <span>No reference</span>
            </button>
            {poseReferenceOptions.map((pose) => (
              <button
                key={pose.path}
                className={`setup-card ${selectedPoseSrc === pose.src ? 'selected' : ''}`}
                onClick={() => setSelectedPoseSrc(pose.src)}
              >
                <img src={pose.src} alt={pose.label} className="setup-card-image" />
                <span>{pose.label}</span>
              </button>
            ))}
          </div>

          <div className="step-actions">
            <button className="secondary-button" onClick={() => setStep('template')}>
              ← Back to Template
            </button>
            <button className="primary-button" onClick={() => setStep('capture')} disabled={!selectedPoseSrc}>
              Start Capturing →
            </button>
          </div>
        </section>
      )}

      {/* STEP 1: CAMERA CAPTURE */}
      {step === 'capture' && (
        <section className="step-section step-capture">
          <div
            className={`capture-container${
              selectedPoseSrc && selectedPoseSrc !== NO_POSE_REFERENCE ? '' : ' capture-container--no-pose-ref'
            }`}
          >
            {selectedPoseSrc && selectedPoseSrc !== NO_POSE_REFERENCE ? (
              <div className="pose-reference-panel">
                <img src={selectedPoseSrc} alt="Pose reference" className="pose-reference-image" />
              </div>
            ) : null}
            <div className="camera-booth-frame">
              <div className="frame-preview-container">
                <div className="capture-frame-fill-layer">
                  {captures.map((shot, index) => {
                    const frame = framePositions[index];
                    return (
                      <div
                        key={shot.id}
                        className="capture-photo-overlay"
                        style={{
                          top: `${(frame.y / templateSize.height) * 100}%`,
                          left: `${(frame.x / templateSize.width) * 100}%`,
                          width: `${(frame.w / templateSize.width) * 100}%`,
                          height: `${(frame.h / templateSize.height) * 100}%`,
                        }}
                      >
                        <img src={shot.src} alt={`Captured frame ${index + 1}`} />
                      </div>
                    );
                  })}

                  {captures.length < framePositions.length && (
                    <div
                      className={`capture-live-overlay ${isFlashing ? 'flash-active' : ''}`}
                      style={{
                        top: `${(activeFrame.y / templateSize.height) * 100}%`,
                        left: `${(activeFrame.x / templateSize.width) * 100}%`,
                        width: `${(activeFrame.w / templateSize.width) * 100}%`,
                        height: `${(activeFrame.h / templateSize.height) * 100}%`,
                      }}
                    >
                      <video ref={videoRef} className="camera-video-preview" autoPlay muted playsInline />
                    </div>
                  )}
                </div>
                <img src={selectedTemplateSrc} alt="Template" className="template-overlay" />
              </div>
              {!cameraReady && (
                <div className="camera-loading">
                  <div className="spinner" />
                  <p>Requesting camera access...</p>
                </div>
              )}
            </div>

            <aside className="capture-sidebar" aria-label="Photobooth capture controls">
              <div className="capture-sidebar-camera">
                <div className="sidebar-camera-card">
                  <h2 className="sidebar-camera-label">Live camera</h2>
                  <div className="sidebar-camera-view">
                    <video ref={sideVideoRef} className="sidebar-camera-video" autoPlay muted playsInline />
                  </div>
                </div>
              </div>

              <div className="capture-sidebar-session">
                <div className="capture-sidebar-progress-label">
                  <span>Progress</span>
                  <span className="capture-sidebar-progress-count">
                    {captures.length} / {framePositions.length}
                  </span>
                </div>
                <div className="progress-bar capture-sidebar-progress">
                  <div className="progress-fill" style={{ width: `${(captures.length / 4) * 100}%` }} />
                </div>
                <div className="side-countdown" aria-live="polite">
                  {countdown > 0 ? countdown : `Photo ${Math.min(captures.length + 1, 4)}/4`}
                </div>
              </div>

              <header className="capture-sidebar-heading capture-sidebar-heading--context">
                <h1 className="capture-sidebar-title">
                  <span className="capture-sidebar-title-emoji" aria-hidden>
                    📸
                  </span>
                  Photobooth Capture
                </h1>
                <p className="capture-sidebar-lead">Four photos for your photostrip</p>
              </header>

              <div className="capture-sidebar-footer">
                <div className="capture-controls">
                  {cameraReady && (
                    <>
                      <button
                        className="capture-btn primary-button capture-btn--primary-lines"
                        type="button"
                        onClick={startCountdown}
                      >
                        <span className="capture-btn-main">Start countdown</span>
                        <span className="capture-btn-meta">5s countdown</span>
                      </button>
                      {videoInputs.length > 1 && (
                        <button className="capture-btn ghost-button" type="button" onClick={switchCamera}>
                          Switch camera
                        </button>
                      )}
                    </>
                  )}
                  {cameraError && <p className="error-text">❌ {cameraError}</p>}
                </div>
              </div>
            </aside>
          </div>
        </section>
      )}

      {/* STEP 2: DESIGN */}
      {step === 'design' && (
        <section className="step-section step-design">
          <div className="design-step-top">
            <div className="design-step-bar">
              <div className="design-step-intro">
                <div className="design-step-heading-row">
                  <span className="design-step-eyebrow">Editor</span>
                  <h1 className="design-step-title">Your photostrip</h1>
                </div>
              </div>
              <nav className="design-step-nav" aria-label="Design step navigation">
                <button type="button" className="design-nav-btn design-nav-btn--back" onClick={goBackToCameraFromDesign}>
                  ← Camera
                </button>
                <button type="button" className="design-nav-btn design-nav-btn--next" onClick={() => setStep('download')}>
                  Next: download →
                </button>
              </nav>
            </div>
          </div>

          <div className="design-layout">
            <aside
              className={`design-sidebar${stickerBrowserOpen ? ' design-sidebar--stickers-browser' : ''}`}
              aria-label={stickerBrowserOpen ? 'Stickers — browse and add' : 'Decorate tools'}
            >
              {stickerBrowserOpen ? (
                <>
                  <div className="design-sticker-browser-header">
                    <button
                      type="button"
                      className="design-sticker-browser-back"
                      onClick={() => setStickerBrowserOpen(false)}
                    >
                      ← Back to tools
                    </button>
                    <h2 className="design-sticker-browser-title">Stickers</h2>
                    <p className="design-sticker-browser-sub">All stickers in this folder — tap to add</p>
                  </div>
                  <div className="design-sticker-browser-folders">
                    <div className="folder-tabs design-folder-tabs" role="tablist" aria-label="Sticker folders">
                      {stickerFolders.map((folder) => (
                        <button
                          key={folder}
                          type="button"
                          role="tab"
                          aria-selected={activeStickerFolder === folder}
                          className={`folder-chip ${activeStickerFolder === folder ? 'selected' : ''}`}
                          onClick={() => setActiveStickerFolder(folder)}
                        >
                          {folder}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="sticker-panel-body sticker-panel-body--browser">
                    <div className="sticker-grid sticker-grid--browser">
                      {stickersInActiveFolder.length > 0 ? (
                        stickersInActiveFolder.map((asset) => (
                          <button
                            key={asset.path}
                            type="button"
                            className="sticker-thumb"
                            onClick={() => void addStickerToCanvas(asset)}
                          >
                            <img src={asset.src} alt="" />
                            <span>{asset.label}</span>
                          </button>
                        ))
                      ) : (
                        <div className="empty-state">No stickers in this folder yet.</div>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="design-sidebar-header">
                    <h2 className="design-sidebar-title">Decorate</h2>
                    <p className="design-sidebar-sub">Editor tools</p>
                  </div>

                  <div className="design-tool-rail" role="toolbar" aria-label="Primary tools">
                    <button
                      type="button"
                      className={`design-rail-btn ${activeDesignTool === 'select' ? 'active' : ''}`}
                      onClick={() => setActiveDesignTool('select')}
                      aria-pressed={activeDesignTool === 'select'}
                      aria-label="Select and transform"
                      title="Select"
                    >
                      <span className="design-rail-icon" aria-hidden>
                        ◇
                      </span>
                      <span className="design-rail-label">Select</span>
                    </button>
                    <button
                      type="button"
                      className={`design-rail-btn ${activeDesignTool === 'draw' ? 'active' : ''}`}
                      onClick={() => setActiveDesignTool('draw')}
                      aria-pressed={activeDesignTool === 'draw'}
                      aria-label="Draw doodles"
                      title="Draw"
                    >
                      <span className="design-rail-icon" aria-hidden>
                        ✎
                      </span>
                      <span className="design-rail-label">Draw</span>
                    </button>
                  </div>

                  <div className="design-panel-stack">
                    <section className="design-panel-card">
                      <header className="design-panel-head">
                        <h3>Stickers</h3>
                        <span className="design-panel-tag">Add</span>
                      </header>
                      <div className="folder-tabs design-folder-tabs" role="tablist" aria-label="Sticker folders">
                        {stickerFolders.map((folder) => (
                          <button
                            key={folder}
                            type="button"
                            role="tab"
                            aria-selected={activeStickerFolder === folder}
                            className={`folder-chip ${activeStickerFolder === folder ? 'selected' : ''}`}
                            onClick={() => setActiveStickerFolder(folder)}
                          >
                            {folder}
                          </button>
                        ))}
                      </div>
                      <div className="sticker-panel-body">
                        <div className="sticker-grid sticker-grid--collapsed">
                          {stickersInActiveFolder.length > 0 ? (
                            previewStickersInFolder.map((asset) => (
                              <button
                                key={asset.path}
                                type="button"
                                className="sticker-thumb"
                                onClick={() => void addStickerToCanvas(asset)}
                              >
                                <img src={asset.src} alt="" />
                                <span>{asset.label}</span>
                              </button>
                            ))
                          ) : (
                            <div className="empty-state">No stickers in this folder yet.</div>
                          )}
                        </div>
                        {stickersInActiveFolder.length > 0 ? (
                          <button
                            type="button"
                            className="sticker-see-more"
                            onClick={() => setStickerBrowserOpen(true)}
                          >
                            See all stickers
                          </button>
                        ) : null}
                      </div>
                    </section>

                    <section className="design-panel-card">
                      <header className="design-panel-head">
                        <h3>Pen</h3>
                        <span className="design-panel-tag">Doodle</span>
                      </header>
                      <p className="design-panel-lead">Choose color and stroke, then use Draw and drag on the strip.</p>
                      <div className="color-palette design-color-row">
                        {DOODLE_PALETTE.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={`color-swatch ${penPaletteActiveColor === color ? 'selected' : ''}`}
                            style={{ background: color }}
                            aria-label={`Doodle color ${color}`}
                            onClick={() => updateSelectedDoodleColor(color)}
                          />
                        ))}
                      </div>
                      <label className="range-label design-range">
                        <span className="design-range-label">Stroke</span>
                        <input
                          type="range"
                          min="4"
                          max="28"
                          value={doodleStrokeWidth}
                          onChange={(event) => updateSelectedDoodleStrokeWidth(Number(event.target.value))}
                        />
                      </label>
                    </section>

                    <section className="design-panel-card design-panel-card-selection">
                      <header className="design-panel-head">
                        <h3>Selection</h3>
                        {selectedDesignElement && <span className="design-panel-tag accent">Active</span>}
                      </header>
                      {selectedDesignElement ? (
                        <div className="selection-card">
                          <p className="selection-title">
                            {selectedDesignElement.kind === 'sticker' ? selectedDesignElement.stickerLabel : 'Doodle stroke'}
                          </p>
                          <p className="selection-meta">
                            {Math.round(selectedDesignElement.rotation)}° · {Math.round(selectedDesignElement.w)} ×{' '}
                            {Math.round(selectedDesignElement.h)} px
                          </p>
                          <p className="sidebar-hint tight">
                            {selectedDesignElement.kind === 'doodle'
                              ? 'Color and stroke: use Pen above. Drag corners to resize, top handle to rotate. Backspace deletes.'
                              : 'Drag corners to resize, top handle to rotate. Backspace deletes.'}
                          </p>
                          <div className="step-actions selection-actions">
                            <button type="button" className="secondary-button" onClick={clearSelectedElement}>
                              Deselect
                            </button>
                            <button type="button" className="ghost-button" onClick={deleteSelectedElement}>
                              Delete
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="sidebar-hint flat">
                          Click an element on the strip to select it. Use Select tool to move, resize, and rotate.
                        </p>
                      )}
                    </section>
                  </div>
                </>
              )}
            </aside>

            <div className="design-workspace">
              <div className="design-zoom-bar" role="toolbar" aria-label="Strip canvas zoom">
                <button
                  type="button"
                  className="design-zoom-btn"
                  aria-label="Zoom out"
                  onClick={() =>
                    setDesignStageZoom((z) => clampValue(z / DESIGN_ZOOM_STEP, DESIGN_ZOOM_MIN, DESIGN_ZOOM_MAX))
                  }
                >
                  −
                </button>
                <span className="design-zoom-value" aria-live="polite">
                  {Math.round(designStageZoom * 100)}%
                </span>
                <button
                  type="button"
                  className="design-zoom-btn"
                  aria-label="Zoom in"
                  onClick={() =>
                    setDesignStageZoom((z) => clampValue(z * DESIGN_ZOOM_STEP, DESIGN_ZOOM_MIN, DESIGN_ZOOM_MAX))
                  }
                >
                  +
                </button>
                <button
                  type="button"
                  className="design-zoom-reset"
                  aria-label="Reset zoom to 100 percent"
                  onClick={() => setDesignStageZoom(1)}
                >
                  Reset
                </button>
              </div>
              <div className="design-stage-viewport">
                <div
                  className="design-stage-scaler"
                  style={{
                    transform: `scale(${designStageZoom})`,
                    transformOrigin: 'center top',
                  }}
                >
                  <div
                    ref={designWorkspaceRef}
                    className={`template-preview-box design-stage ${activeDesignTool === 'draw' ? 'design-stage-draw' : ''}`}
                    style={{ cursor: activeDesignTool === 'draw' ? 'crosshair' : designPointerCursor }}
                    onPointerDown={(event) => {
                      if (activeDesignTool === 'draw') {
                        startDoodleStroke(event);
                        return;
                      }

                      if (event.target === event.currentTarget) {
                        clearSelectedElement();
                      }
                    }}
                  >
                <div className="photo-overlays">
                  {captures.map((shot, index) => {
                    const frame = framePositions[index];
                    return (
                      <div
                        key={shot.id}
                        className="photo-overlay"
                        style={{
                          top: `${(frame.y / templateSize.height) * 100}%`,
                          left: `${(frame.x / templateSize.width) * 100}%`,
                          width: `${(frame.w / templateSize.width) * 100}%`,
                          height: `${(frame.h / templateSize.height) * 100}%`,
                        }}
                      >
                        <img src={shot.src} alt={`Photo ${index + 1}`} />
                      </div>
                    );
                  })}
                </div>

                <img src={selectedTemplateSrc} alt="Template" className="template-base" />

                {designElements.map((element) => {
                  const isSelected = element.id === selectedDesignId;
                  const commonStyle = {
                    left: `${(element.x / templateSize.width) * 100}%`,
                    top: `${(element.y / templateSize.height) * 100}%`,
                    width: `${(element.w / templateSize.width) * 100}%`,
                    height: `${(element.h / templateSize.height) * 100}%`,
                    transform: `rotate(${element.rotation}deg)`,
                    transformOrigin: 'center center',
                  } as React.CSSProperties;

                  return (
                    <div
                      key={element.id}
                      className={`design-element ${element.kind} ${isSelected ? 'selected' : ''}`}
                      style={commonStyle}
                      onPointerDown={(event) => beginElementDrag(event, element.id)}
                    >
                      {element.kind === 'sticker' ? (
                        <img src={element.stickerSrc} alt={element.stickerLabel} className="design-element-image" />
                      ) : (
                        <svg viewBox="0 0 100 100" className="design-doodle-svg" aria-hidden="true">
                          <path
                            d={buildDoodlePathFromNormalized(element.points)}
                            fill="none"
                            stroke={element.color}
                            strokeWidth={(element.strokeWidth * 100) / Math.max(element.w, 1)}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}

                      {isSelected && activeDesignTool === 'select' && (
                        <div className="design-transform-layer" aria-hidden="true">
                          <span className="design-selection-border" />
                          <button
                            type="button"
                            className="design-rotate-handle"
                            aria-label="Rotate"
                            onPointerDown={(event) => beginElementRotate(event, element.id)}
                          />
                          <button
                            type="button"
                            className="design-resize-handle nw"
                            aria-label="Resize from top left"
                            onPointerDown={(event) => beginElementResize(event, element.id, 'nw')}
                          />
                          <button
                            type="button"
                            className="design-resize-handle ne"
                            aria-label="Resize from top right"
                            onPointerDown={(event) => beginElementResize(event, element.id, 'ne')}
                          />
                          <button
                            type="button"
                            className="design-resize-handle sw"
                            aria-label="Resize from bottom left"
                            onPointerDown={(event) => beginElementResize(event, element.id, 'sw')}
                          />
                          <button
                            type="button"
                            className="design-resize-handle se"
                            aria-label="Resize from bottom right"
                            onPointerDown={(event) => beginElementResize(event, element.id, 'se')}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}

                {isDrawingDoodle && draftDoodlePoints.length > 0 && (
                  <svg
                    className="design-draft-overlay"
                    viewBox={`0 0 ${templateSize.width} ${templateSize.height}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    {draftDoodlePoints.length === 1 ? (
                      <circle
                        cx={draftDoodlePoints[0].x}
                        cy={draftDoodlePoints[0].y}
                        r={doodleStrokeWidth / 2}
                        fill={doodleColor}
                      />
                    ) : (
                      <path
                        d={buildDoodlePathTemplatePixels(draftDoodlePoints)}
                        fill="none"
                        stroke={doodleColor}
                        strokeWidth={doodleStrokeWidth}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </svg>
                )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* STEP 3: DOWNLOAD */}
      {step === 'download' && (
        <section className="step-section step-download">
          <div className="step-header">
            <h1>🎉 Your Photostrip is Ready!</h1>
            <p>Download and share your memories</p>
          </div>

          <div className="download-preview">
            <div className="template-preview-box">
              <div className="photo-overlays">
                {captures.map((shot, index) => {
                  const frame = framePositions[index];
                  return (
                    <div
                      key={shot.id}
                      className="photo-overlay"
                      style={{
                        top: `${(frame.y / templateSize.height) * 100}%`,
                        left: `${(frame.x / templateSize.width) * 100}%`,
                        width: `${(frame.w / templateSize.width) * 100}%`,
                        height: `${(frame.h / templateSize.height) * 100}%`,
                      }}
                    >
                      <img src={shot.src} alt={`Final photo ${index + 1}`} />
                    </div>
                  );
                })}
              </div>
              <img src={selectedTemplateSrc} alt="Final photostrip" className="template-preview-final" />

              {designElements.map((element) => (
                <div
                  key={element.id}
                  className={`design-element ${element.kind} design-element-static`}
                  style={{
                    left: `${(element.x / templateSize.width) * 100}%`,
                    top: `${(element.y / templateSize.height) * 100}%`,
                    width: `${(element.w / templateSize.width) * 100}%`,
                    height: `${(element.h / templateSize.height) * 100}%`,
                    transform: `rotate(${element.rotation}deg)`,
                    transformOrigin: 'center center',
                  }}
                >
                  {element.kind === 'sticker' ? (
                    <img src={element.stickerSrc} alt="" className="design-element-image" />
                  ) : (
                    <svg viewBox="0 0 100 100" className="design-doodle-svg" aria-hidden="true">
                      <path
                        d={buildDoodlePathFromNormalized(element.points)}
                        fill="none"
                        stroke={element.color}
                        strokeWidth={(element.strokeWidth * 100) / Math.max(element.w, 1)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="step-actions">
            <button className="secondary-button" onClick={() => setStep('design')}>
              ← Back to Design
            </button>
            <button className="primary-button" onClick={downloadCard}>
              ⬇ Download PNG
            </button>
            <button className="ghost-button" onClick={resetPhotobooth}>
              🔄 Start Over
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load image.'));
    image.src = src;
  });
}

function createSvgDataUrl(svgMarkup: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
}

function buildDoodleSvg(path: string, color: string, strokeWidth: number) {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
      <path
        d="${path}"
        fill="none"
        stroke="${color}"
        stroke-width="${strokeWidth}"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;
}

function getTemplateFallbackFrames(templateSrc: string, size: TemplateSize): FrameBox[] {
  const key = templateSrc.toLowerCase();

  if (key.includes('code black') || key.includes('code white')) {
    // Hand-tuned frame boxes for `src/template/code Black.png` / `src/template/Code White.png` (600x1800).
    const codeBlackBase = [
      { x: 22, y: 40, w: 556, h: 280 },
      { x: 22, y: 335, w: 556, h: 430 },
      { x: 160, y: 1030, w: 420, h: 265 },
      { x: 22, y: 1290, w: 556, h: 410 },
    ];

    const sx = size.width / 600;
    const sy = size.height / 1800;
    return codeBlackBase.map((frame) => ({
      x: Math.round(frame.x * sx),
      y: Math.round(frame.y * sy),
      w: Math.round(frame.w * sx),
      h: Math.round(frame.h * sy),
    }));
  }

  // Default fallback scales the Pink Retro baseline frame mapping.
  const sx = size.width / DEFAULT_TEMPLATE_WIDTH;
  const sy = size.height / DEFAULT_TEMPLATE_HEIGHT;
  return DEFAULT_FRAME_POSITIONS.map((frame) => ({
    x: Math.round(frame.x * sx),
    y: Math.round(frame.y * sy),
    w: Math.round(frame.w * sx),
    h: Math.round(frame.h * sy),
  }));
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  dx: number,
  dy: number,
  dWidth: number,
  dHeight: number,
) {
  const imageRatio = image.width / image.height;
  const frameRatio = dWidth / dHeight;

  let sx = 0;
  let sy = 0;
  let sWidth = image.width;
  let sHeight = image.height;

  if (imageRatio > frameRatio) {
    sWidth = image.height * frameRatio;
    sx = (image.width - sWidth) / 2;
  } else {
    sHeight = image.width / frameRatio;
    sy = (image.height - sHeight) / 2;
  }

  context.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
}

function drawVideoCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  dWidth: number,
  dHeight: number,
  mirror = false,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = dWidth / dHeight;

  let sx = 0;
  let sy = 0;
  let sWidth = sourceWidth;
  let sHeight = sourceHeight;

  if (sourceRatio > targetRatio) {
    sWidth = sourceHeight * targetRatio;
    sx = (sourceWidth - sWidth) / 2;
  } else {
    sHeight = sourceWidth / targetRatio;
    sy = (sourceHeight - sHeight) / 2;
  }

  if (mirror) {
    context.save();
    context.translate(dWidth, 0);
    context.scale(-1, 1);
    context.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, dWidth, dHeight);
    context.restore();
  } else {
    context.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, dWidth, dHeight);
  }
}

function drawVideoCoverAt(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  dx: number,
  dy: number,
  dWidth: number,
  dHeight: number,
  mirror = false,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = dWidth / dHeight;

  let sx = 0;
  let sy = 0;
  let sWidth = sourceWidth;
  let sHeight = sourceHeight;

  if (sourceRatio > targetRatio) {
    sWidth = sourceHeight * targetRatio;
    sx = (sourceWidth - sWidth) / 2;
  } else {
    sHeight = sourceWidth / targetRatio;
    sy = (sourceHeight - sHeight) / 2;
  }

  if (mirror) {
    context.save();
    context.translate(dx + dWidth, dy);
    context.scale(-1, 1);
    context.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, dWidth, dHeight);
    context.restore();
  } else {
    context.drawImage(video, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
  }
}

function drawRotatedContainImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
) {
  const imageRatio = image.width / image.height;
  const frameRatio = w / h;

  let drawWidth = w;
  let drawHeight = h;

  if (imageRatio > frameRatio) {
    drawHeight = w / imageRatio;
  } else {
    drawWidth = h * imageRatio;
  }

  context.save();
  context.translate(x + w / 2, y + h / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();
}

function buildDoodlePathFromNormalized(points: DoodlePoint[]) {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M ${(points[0].nx * 100).toFixed(2)} ${(points[0].ny * 100).toFixed(2)}`;
  }

  const pathPoints = points.map((point) => ({
    x: point.nx * 100,
    y: point.ny * 100,
  }));

  const commands: string[] = [`M ${pathPoints[0].x.toFixed(2)} ${pathPoints[0].y.toFixed(2)}`];

  for (let i = 1; i < pathPoints.length - 1; i += 1) {
    const current = pathPoints[i];
    const next = pathPoints[i + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    commands.push(`Q ${current.x.toFixed(2)} ${current.y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`);
  }

  const lastPoint = pathPoints[pathPoints.length - 1];
  commands.push(`L ${lastPoint.x.toFixed(2)} ${lastPoint.y.toFixed(2)}`);

  return commands.join(' ');
}

function buildDoodlePathTemplatePixels(points: Point[]) {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  }

  const commands: string[] = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];

  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    commands.push(
      `Q ${current.x.toFixed(2)} ${current.y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`,
    );
  }

  const lastPoint = points[points.length - 1];
  commands.push(`L ${lastPoint.x.toFixed(2)} ${lastPoint.y.toFixed(2)}`);

  return commands.join(' ');
}

function drawDoodleOnCanvas(
  context: CanvasRenderingContext2D,
  points: DoodlePoint[],
  bounds: FrameBox,
  rotation: number,
  color: string,
  strokeWidth: number,
) {
  if (points.length === 0) return;

  const mappedPoints = points.map((point) => ({
    x: point.nx * bounds.w,
    y: point.ny * bounds.h,
  }));

  context.save();
  context.translate(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.translate(-bounds.w / 2, -bounds.h / 2);
  context.beginPath();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = color;
  context.lineWidth = strokeWidth;

  if (mappedPoints.length === 1) {
    context.arc(mappedPoints[0].x, mappedPoints[0].y, strokeWidth / 2, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.restore();
    return;
  }

  context.moveTo(mappedPoints[0].x, mappedPoints[0].y);

  for (let i = 1; i < mappedPoints.length - 1; i += 1) {
    const current = mappedPoints[i];
    const next = mappedPoints[i + 1];
    context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }

  const lastPoint = mappedPoints[mappedPoints.length - 1];
  context.lineTo(lastPoint.x, lastPoint.y);
  context.stroke();
  context.restore();
}

function detectTransparentFrames(template: HTMLImageElement): FrameBox[] {
  const canvas = document.createElement('canvas');
  canvas.width = template.naturalWidth;
  canvas.height = template.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) return [];

  context.drawImage(template, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;
  const visited = new Uint8Array(width * height);
  const components: Array<{ x: number; y: number; w: number; h: number; area: number }> = [];
  const alphaThreshold = 12;
  const minArea = 5000;

  function isTransparent(pixelIndex: number) {
    const alpha = data[pixelIndex * 4 + 3];
    return alpha <= alphaThreshold;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (visited[index] || !isTransparent(index)) {
        visited[index] = 1;
        continue;
      }

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;
      const queue: number[] = [index];
      visited[index] = 1;

      while (queue.length > 0) {
        const current = queue.pop()!;
        const cx = current % width;
        const cy = Math.floor(current / width);

        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighborIndexes: number[] = [];
        if (cx > 0) neighborIndexes.push(current - 1);
        if (cx < width - 1) neighborIndexes.push(current + 1);
        if (cy > 0) neighborIndexes.push(current - width);
        if (cy < height - 1) neighborIndexes.push(current + width);

        for (const next of neighborIndexes) {
          if (visited[next]) continue;
          visited[next] = 1;
          if (isTransparent(next)) {
            queue.push(next);
          }
        }
      }

      if (area >= minArea) {
        components.push({
          x: minX,
          y: minY,
          w: maxX - minX + 1,
          h: maxY - minY + 1,
          area,
        });
      }
    }
  }

  return components
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
    .slice(0, 4)
    .map(({ x, y, w, h }) => ({ x, y, w, h }));
}

async function getPreferredCameraStream(preferredDeviceId: string | null): Promise<CameraSelection> {
  if (preferredDeviceId) {
    const selectedStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: preferredDeviceId } },
      audio: false,
    });
    const facingMode = selectedStream.getVideoTracks()[0]?.getSettings().facingMode;
    return {
      stream: selectedStream,
      usingBackCamera: facingMode === 'environment',
      selectedDeviceId: preferredDeviceId,
    };
  }

  try {
    const backStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: 'environment' } },
      audio: false,
    });
    const deviceId = backStream.getVideoTracks()[0]?.getSettings().deviceId;
    return { stream: backStream, usingBackCamera: true, selectedDeviceId: deviceId };
  } catch {
    // Continue to fallback path.
  }

  const initialStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const rearDevice = devices.find(
      (device) =>
        device.kind === 'videoinput' &&
        /back|rear|environment|world|traseira|arriere/i.test(device.label),
    );

    if (rearDevice) {
      const rearStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: rearDevice.deviceId } },
        audio: false,
      });
      initialStream.getTracks().forEach((track) => track.stop());
      return { stream: rearStream, usingBackCamera: true, selectedDeviceId: rearDevice.deviceId };
    }
  } catch {
    // If enumerate/select fails, continue with initial stream.
  }

  const facingMode = initialStream.getVideoTracks()[0]?.getSettings().facingMode;
  const deviceId = initialStream.getVideoTracks()[0]?.getSettings().deviceId;
  return {
    stream: initialStream,
    usingBackCamera: facingMode === 'environment',
    selectedDeviceId: deviceId,
  };
}