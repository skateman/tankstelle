import { useEffect, useRef, useState } from 'react';

type Props = {
  onCapture: (file: File) => void;
  onCancel: () => void;
};

export default function InAppCamera({ onCapture, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [shooting, setShooting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera API not available. (Requires HTTPS.)');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1920 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setReady(true);
      } catch (e) {
        const name = (e as DOMException).name || 'Error';
        const msg = (e as Error).message || String(e);
        setError(`${name}: ${msg}`);
      }
    }

    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  async function shoot() {
    const video = videoRef.current;
    if (!video || !ready) return;
    setShooting(true);
    try {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.drawImage(video, 0, 0, w, h);
      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.9),
      );
      if (!blob) throw new Error('Failed to encode JPEG');
      const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      onCapture(file);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setShooting(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-2 rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-sm">
        <p className="text-amber-300">In-app camera unavailable: {error}</p>
        <p className="text-amber-200">
          Falling back to the system camera (photo will be saved to Photos).
        </p>
        <button type="button" onClick={onCancel} className="btn-ghost w-full">
          Use system camera instead
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-cover"
        />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">
            Starting camera…
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={shoot}
          disabled={!ready || shooting}
          className="btn-primary flex-1 disabled:opacity-50"
        >
          {shooting ? 'Capturing…' : '📸 Capture'}
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost">
          Cancel
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Photo stays in this app and is not saved to your Photos library.
      </p>
    </div>
  );
}
