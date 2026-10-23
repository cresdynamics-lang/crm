import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)

// Hot module replacement is wrong for this app. Its state is a live microphone
// loop, an open socket and a speaking voice, none of which a swapped-in module
// knows about: after a hot update the old loop keeps running on the old code,
// the new code is never started, and the result is an assistant that looks
// alive and has stopped answering. Any update reloads the page instead, and it
// powers back up by itself.
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => window.location.reload())
}
