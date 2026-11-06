// Opens the device camera into a <video> element, and turns camera failures into plain English.

// Not a gameplay number: how long to wait for the first frame before giving up, so the
// start screen can never hang forever if another app is holding the camera.
const FRAME_WAIT_TIMEOUT_MS = 8000;

export async function startCamera(videoEl) {
  // No mediaDevices at all means the page is not on https:// or localhost.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const error = new Error('The camera needs a secure page: https:// or localhost.');
    error.name = 'InsecureContextError';
    throw error;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });

  videoEl.srcObject = stream;
  await videoEl.play();
  await waitForFrame(videoEl);
  return stream;
}

// Resolves once the video really has a picture, not just a stream object.
function waitForFrame(videoEl) {
  return new Promise((resolve, reject) => {
    const hasFrame = () => videoEl.readyState >= 1 && videoEl.videoWidth > 0;
    if (hasFrame()) return resolve();

    const timer = setTimeout(() => {
      stopWaiting();
      reject(new Error('The camera opened but never showed a picture. Close other apps using the camera, then reload.'));
    }, FRAME_WAIT_TIMEOUT_MS);

    function stopWaiting() {
      clearTimeout(timer);
      videoEl.removeEventListener('loadedmetadata', check);
      videoEl.removeEventListener('timeupdate', check); // some phones only fill frames later
    }

    function check() {
      if (!hasFrame()) return;
      stopWaiting();
      resolve();
    }

    videoEl.addEventListener('loadedmetadata', check);
    videoEl.addEventListener('timeupdate', check);
  });
}

export function cameraHelp(error) {
  const name = (error && error.name) || '';

  if (!navigator.mediaDevices || name === 'InsecureContextError') {
    return 'The camera only works on https:// or on localhost. This page is on neither, so the browser hides it.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The browser blocked the camera. Tap Allow, or check your site settings.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'No camera found. Plug one in, or open the game on a phone.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'The camera is busy in another app. Close it, then tap again.';
  }
  return 'The camera did not start. Reload the page and tap the button again.';
}
