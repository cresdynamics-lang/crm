/**
 * In-app voice, video, and screen share over WebRTC.
 * Signaling stays on the CRM socket — nothing leaves the app.
 */
const CresCalls = (() => {
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

  let pc = null;
  let localStream = null;
  let screenStream = null;
  let current = null;
  let makingOffer = false;

  function overlay() {
    return document.getElementById('call-overlay');
  }

  function remoteEl() {
    return document.getElementById('call-remote');
  }

  function localEl() {
    return document.getElementById('call-local');
  }

  function bannerEl() {
    return document.getElementById('call-banner');
  }

  function setBanner(text) {
    const el = bannerEl();
    if (el) el.textContent = text || '';
  }

  function showOverlay(mode) {
    const el = overlay();
    if (!el) return;
    el.hidden = false;
    el.dataset.mode = mode;
    const accept = document.getElementById('call-accept');
    const decline = document.getElementById('call-decline');
    const hangup = document.getElementById('call-hangup');
    if (accept) accept.hidden = mode !== 'incoming';
    if (decline) decline.hidden = mode !== 'incoming';
    if (hangup) hangup.hidden = mode === 'incoming';
  }

  function hideOverlay() {
    const el = overlay();
    if (el) {
      el.hidden = true;
      el.dataset.mode = '';
    }
  }

  function kindLabel(kind) {
    if (kind === 'video') return 'Video call';
    if (kind === 'screen') return 'Screen share';
    return 'Voice call';
  }

  async function mediaFor(kind) {
    if (kind === 'screen') {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      let mic = null;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch {
        mic = null;
      }
      const stream = new MediaStream();
      display.getVideoTracks().forEach((t) => stream.addTrack(t));
      (mic || display).getAudioTracks().forEach((t) => stream.addTrack(t));
      screenStream = display;
      return stream;
    }
    const video = kind === 'video';
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user', width: { ideal: 1280 } } : false,
    });
  }

  function attachLocal(stream) {
    localStream = stream;
    const video = localEl();
    if (video) {
      video.srcObject = stream;
      video.muted = true;
      video.play().catch(() => {});
    }
  }

  function attachRemote(stream) {
    const video = remoteEl();
    if (video) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
  }

  function bindPc(peerConnection) {
    peerConnection.onicecandidate = (ev) => {
      if (ev.candidate && current) {
        CresRealtime.emitCall('call:ice', { callId: current.callId, candidate: ev.candidate });
      }
    };
    peerConnection.ontrack = (ev) => {
      attachRemote(ev.streams[0] || new MediaStream([ev.track]));
    };
    peerConnection.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(peerConnection.connectionState)) {
        if (peerConnection.connectionState === 'failed') hangup(true);
      }
    };
  }

  async function ensurePc() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: ICE });
    bindPc(pc);
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }
    return pc;
  }

  async function makeOffer() {
    const peer = await ensurePc();
    makingOffer = true;
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      CresRealtime.emitCall('call:offer', { callId: current.callId, sdp: peer.localDescription });
    } finally {
      makingOffer = false;
    }
  }

  async function startCall({ peerId, peerName, kind, conversationId }) {
    if (current) {
      alert('You are already on a call.');
      return;
    }
    if (CresRealtime.getStatus() !== 'online') {
      alert('Realtime is offline. Calls need a live connection.');
      return;
    }
    const callId = crypto.randomUUID();
    current = {
      callId,
      peerId,
      peerName,
      kind: kind || 'audio',
      conversationId,
      direction: 'out',
    };
    showOverlay('outgoing');
    setBanner(`Calling ${peerName} · ${kindLabel(current.kind)}`);
    const sent = CresRealtime.emitCall('call:invite', {
      callId,
      to: peerId,
      kind: current.kind,
      conversationId,
    });
    if (!sent) {
      await teardown();
      alert('Could not start the call.');
    }
  }

  async function acceptIncoming() {
    if (!current || current.direction !== 'in') return;
    try {
      const stream = await mediaFor(current.kind);
      attachLocal(stream);
      showOverlay('active');
      setBanner(`${kindLabel(current.kind)} · ${current.peerName}`);
      CresRealtime.emitCall('call:accept', { callId: current.callId });
      await ensurePc();
    } catch (err) {
      alert(err.message || 'Could not open camera or microphone');
      CresRealtime.emitCall('call:reject', { callId: current.callId });
      await teardown();
    }
  }

  function rejectIncoming() {
    if (!current) return;
    CresRealtime.emitCall('call:reject', { callId: current.callId });
    teardown();
  }

  async function hangup(remote) {
    if (current && !remote) {
      CresRealtime.emitCall('call:hangup', { callId: current.callId });
    }
    await teardown();
  }

  async function teardown() {
    try {
      pc?.getSenders().forEach((s) => {
        try {
          s.track?.stop();
        } catch {
          /* ignore */
        }
      });
      pc?.close();
    } catch {
      /* ignore */
    }
    pc = null;
    localStream?.getTracks().forEach((t) => t.stop());
    screenStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    screenStream = null;
    current = null;
    makingOffer = false;
    if (remoteEl()) remoteEl().srcObject = null;
    if (localEl()) localEl().srcObject = null;
    hideOverlay();
  }

  async function toggleMute() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled;
    });
    const btn = document.getElementById('call-mute');
    const live = localStream.getAudioTracks().some((t) => t.enabled);
    if (btn) btn.textContent = live ? 'Mute' : 'Unmute';
  }

  async function toggleCamera() {
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender?.track) {
      sender.track.enabled = !sender.track.enabled;
      const btn = document.getElementById('call-cam');
      if (btn) btn.textContent = sender.track.enabled ? 'Camera off' : 'Camera on';
      return;
    }
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = cam.getVideoTracks()[0];
      if (sender) await sender.replaceTrack(track);
      else pc.addTrack(track, localStream || cam);
      if (localStream) localStream.addTrack(track);
      else attachLocal(cam);
      const btn = document.getElementById('call-cam');
      if (btn) btn.textContent = 'Camera off';
    } catch (err) {
      alert(err.message || 'Camera unavailable');
    }
  }

  async function shareScreen() {
    if (!pc || !current) return;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      screenStream = display;
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      else pc.addTrack(track, display);
      track.onended = () => {
        /* user stopped sharing from the browser chrome */
      };
      setBanner(`Screen share · ${current.peerName}`);
    } catch (err) {
      if (err.name !== 'NotAllowedError') alert(err.message || 'Screen share failed');
    }
  }

  async function onSignal(msg) {
    if (!msg?.event) return;
    const event = msg.event;

    if (event === 'call:invite') {
      if (current) {
        CresRealtime.emitCall('call:reject', { callId: msg.callId });
        return;
      }
      current = {
        callId: msg.callId,
        peerId: msg.from,
        peerName: msg.fromName || 'Teammate',
        kind: msg.kind || 'audio',
        conversationId: msg.conversationId,
        direction: 'in',
      };
      showOverlay('incoming');
      setBanner(`${current.peerName} · incoming ${kindLabel(current.kind).toLowerCase()}`);
      return;
    }

    if (!current || (msg.callId && msg.callId !== current.callId)) return;

    if (event === 'call:reject') {
      setBanner('Call declined');
      setTimeout(() => teardown(), 800);
      return;
    }
    if (event === 'call:hangup') {
      await teardown();
      return;
    }

    if (event === 'call:accept' && current.direction === 'out') {
      try {
        const stream = await mediaFor(current.kind);
        attachLocal(stream);
        showOverlay('active');
        setBanner(`${kindLabel(current.kind)} · ${current.peerName}`);
        await ensurePc();
        await makeOffer();
      } catch (err) {
        alert(err.message || 'Could not open camera or microphone');
        hangup(false);
      }
      return;
    }

    if (event === 'call:offer') {
      const peer = await ensurePc();
      if (makingOffer) return;
      await peer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      CresRealtime.emitCall('call:answer', { callId: current.callId, sdp: peer.localDescription });
      return;
    }

    if (event === 'call:answer') {
      const peer = await ensurePc();
      if (!peer.currentRemoteDescription) {
        await peer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
      return;
    }

    if (event === 'call:ice' && msg.candidate) {
      try {
        const peer = await ensurePc();
        await peer.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch {
        /* candidate may arrive early */
      }
    }
  }

  function bind() {
    document.getElementById('call-accept')?.addEventListener('click', () => acceptIncoming());
    document.getElementById('call-decline')?.addEventListener('click', () => rejectIncoming());
    document.getElementById('call-hangup')?.addEventListener('click', () => hangup(false));
    document.getElementById('call-mute')?.addEventListener('click', () => toggleMute());
    document.getElementById('call-cam')?.addEventListener('click', () => toggleCamera());
    document.getElementById('call-share')?.addEventListener('click', () => shareScreen());
    CresRealtime.on('call', (msg) => {
      onSignal(msg).catch((err) => console.error('[call]', err));
    });
  }

  return { bind, startCall, hangup };
})();
