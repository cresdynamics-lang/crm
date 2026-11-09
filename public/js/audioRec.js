/**
 * Pick a recording format the browser supports: Chrome/Edge/Android record
 * WebM/Opus, Safari and iPhone record MP4/AAC. Forcing WebM makes recording
 * fail outright on iPhone, so every voice feature asks here.
 */
const CresAudio = (() => {
  const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];

  function pick() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  /** new MediaRecorder with the best supported format (or the browser default). */
  function recorder(stream) {
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Voice recording is not supported in this browser. Use Chrome, Edge or Safari 14.5+.');
    }
    const mime = pick();
    return mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  }

  function blobType(rec) {
    return (rec && rec.mimeType) || pick() || 'audio/webm';
  }

  function ext(mime) {
    const m = String(mime || '');
    if (m.includes('mp4') || m.includes('aac')) return 'm4a';
    if (m.includes('ogg')) return 'ogg';
    return 'webm';
  }

  /** Mic with echo cancelling and noise removal: clearer audio, better transcripts. */
  function mic() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  }

  return { pick, recorder, blobType, ext, mic };
})();
